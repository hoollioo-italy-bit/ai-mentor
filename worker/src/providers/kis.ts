/**
 * 한국투자증권 KIS OpenAPI 어댑터 — Phase 4.
 *
 * ⚠ UNVERIFIED / 미완결 —
 *   · 본 실행 환경에서 외부 호출이 차단되어 실호출 검증을 하지 못했다.
 *   · 실계좌 앱키(KIS_APP_KEY/KIS_APP_SECRET)가 없으면 동작하지 않는다.
 *   · 분봉 엔드포인트는 1회 조회당 30건 제한이 있어 페이지네이션이 필요하다(아래 TODO).
 *   전환 절차와 체크리스트는 docs/provider-migration.md 를 따르십시오.
 *
 * 내부 표준 타입(§3.1)만 외부로 노출한다 — 원본 필드명(stck_bsop_date 등)은 이 파일을 벗어나지 않는다.
 */

import type { Candle, Interval, PriceProvider, StockSymbol } from "@app/shared";
import type { Env } from "../lib/env.js";
import { fetchText, RateLimiter } from "../lib/http.js";
import { SchemaError, validateCandles, quoteSchema } from "./schema.js";
import { KST_OFFSET_MS } from "../lib/time.js";
import { num, parseYmdToKstEpoch, parseYmdHmToKstEpoch } from "./naver.js";
import { resampleMinutes } from "./aggregate.js";

const SOURCE = "kis";
const TOKEN_KEY = "kis:access_token";
/** KIS 유통 제한: 초당 20건(실전). 보수적으로 10/s. */
const limiter = new RateLimiter(10, 10);

/** 시장구분 코드 — StockSymbol.providerKey 에 보관되는 값(J=주식/ETF/ETN 통합조회). */
export const KIS_MARKET_KEY = { J: "주식·ETF·ETN", NX: "NXT", UN: "통합" } as const;

type TokenDoc = { token: string; expiresAt: number };

async function getToken(env: Env): Promise<string> {
  const cached = await env.KV.get<TokenDoc>(TOKEN_KEY, "json");
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const base = env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
  const url = `${base}/oauth2/tokenP`;
  const body = await fetchText(url, {
    source: SOURCE, limiter, retries: 2,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET }),
    },
  });
  const json = JSON.parse(body) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new SchemaError(SOURCE, url, "access_token 없음", body.slice(0, 300));
  const doc: TokenDoc = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000 };
  // KIS 토큰은 1일 1회 발급 제한이 있으므로 반드시 캐시한다.
  await env.KV.put(TOKEN_KEY, JSON.stringify(doc), { expirationTtl: Math.max(120, (json.expires_in ?? 86_400) - 120) });
  return doc.token;
}

async function call(env: Env, path: string, trId: string, query: Record<string, string>): Promise<Record<string, unknown>> {
  const base = env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
  const url = `${base}${path}?${new URLSearchParams(query).toString()}`;
  const token = await getToken(env);
  const body = await fetchText(url, {
    source: SOURCE, limiter,
    init: {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY ?? "",
        appsecret: env.KIS_APP_SECRET ?? "",
        tr_id: trId,
        custtype: "P",
        "Content-Type": "application/json",
      },
    },
  });
  let json: Record<string, unknown>;
  try { json = JSON.parse(body) as Record<string, unknown>; }
  catch { throw new SchemaError(SOURCE, url, "JSON 파싱 실패", body.slice(0, 300)); }
  if (json["rt_cd"] !== "0") {
    throw new SchemaError(SOURCE, url, `rt_cd=${String(json["rt_cd"])} msg=${String(json["msg1"] ?? "")}`, body.slice(0, 300));
  }
  return json;
}

export function createKisProvider(env: Env, deps: { searchSymbols: (k: string) => Promise<StockSymbol[]> }): PriceProvider {
  return {
    searchSymbols: deps.searchSymbols,

    async getCandles(code, interval, from, to): Promise<Candle[]> {
      if (interval === "1d" || interval === "1w" || interval === "1M") {
        const period = interval === "1d" ? "D" : interval === "1w" ? "W" : "M";
        const json = await call(env, "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
          "FHKST03010100", {
            FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: ymd(from), FID_INPUT_DATE_2: ymd(to),
            FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: "0",   // 0 = 수정주가 반영 (§3.3)
          });
        const rows = asRows(json["output2"]);
        const candles: Candle[] = [];
        for (const r of rows) {
          const t = parseYmdToKstEpoch(String(r["stck_bsop_date"] ?? ""));
          const o = num(r["stck_oprc"]), h = num(r["stck_hgpr"]), l = num(r["stck_lwpr"]), c = num(r["stck_clpr"]);
          const v = num(r["acml_vol"]), va = num(r["acml_tr_pbmn"]);
          if (t === null || o === null || h === null || l === null || c === null || v === null) continue;
          if (o <= 0 || c <= 0) continue;
          candles.push({ t, o, h, l, c, v, va: va ?? Math.round(c * v), adj: true });
        }
        candles.sort((a, b) => a.t - b.t);
        return validateCandles(SOURCE, "inquire-daily-itemchartprice", candles, { minCount: 1 });
      }

      // TODO(Phase 4): 분봉은 1회 30건 제한 → FID_INPUT_HOUR_1 을 역방향으로 이동하며 페이지네이션.
      const json = await call(env, "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
        "FHKST03010200", {
          FID_ETC_CLS_CODE: "", FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
          FID_INPUT_HOUR_1: "153000", FID_PW_DATA_INCU_YN: "Y",
        });
      const rows = asRows(json["output2"]);
      const ones: Candle[] = [];
      for (const r of rows) {
        const d = String(r["stck_bsop_date"] ?? "");
        const hm = String(r["stck_cntg_hour"] ?? "").slice(0, 4);
        const t = parseYmdHmToKstEpoch(`${d}${hm}`);
        const o = num(r["stck_oprc"]), h = num(r["stck_hgpr"]), l = num(r["stck_lwpr"]), c = num(r["stck_prpr"]);
        const v = num(r["cntg_vol"]);
        if (t === null || o === null || h === null || l === null || c === null || v === null) continue;
        ones.push({ t, o, h, l, c, v, va: Math.round(c * v), adj: true });
      }
      ones.sort((a, b) => a.t - b.t);
      const filtered = ones.filter((x) => x.t >= from.getTime() && x.t <= to.getTime());
      const checked = validateCandles(SOURCE, "inquire-time-itemchartprice", filtered, { minCount: 1 });
      return interval === "1m" ? checked : resampleMinutes(checked, interval === "5m" ? 5 : 30);
    },

    async getQuote(code) {
      const json = await call(env, "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code });
      const o = (json["output"] ?? {}) as Record<string, unknown>;
      const quote = {
        price: num(o["stck_prpr"]) ?? NaN,
        change: num(o["prdy_vrss"]) ?? NaN,
        changeRate: num(o["prdy_ctrt"]) ?? NaN,
        t: Date.now(),
      };
      const parsed = quoteSchema.safeParse(quote);
      if (!parsed.success) throw new SchemaError(SOURCE, "inquire-price", parsed.error.issues.map((i) => i.message).join("; "), "");
      return parsed.data;
    },
  };
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function ymd(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`;
}

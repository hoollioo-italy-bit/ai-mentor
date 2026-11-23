/**
 * KRX(한국거래소) 어댑터 — 종목마스터 + 일봉 폴백 + 거래대금/상태 보강.
 *
 * ⚠ UNVERIFIED — data.krx.co.kr 역시 본 실행 환경에서 차단되어(HTTP 403 at proxy)
 *   아래 bld 식별자와 응답 필드명은 공개적으로 알려진 값에 기반한 가설이다.
 *   `scripts/verify-provider.ts --source krx` 로 로컬 검증 후 확정하십시오.
 *
 * 호출 규약(가설)
 *   POST https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd
 *   Content-Type: application/x-www-form-urlencoded
 *   Referer: https://data.krx.co.kr/contents/MDC/MDI/mdiLoader   ← 없으면 거부됨
 *   body: bld=<식별자>&...파라미터
 *   응답: { "OutBlock_1": [ { ...문자열 필드... } ] }  또는  { "output": [...] }
 */

import type { Candle, Market, StockSymbol } from "@app/shared";
import { fetchText, RateLimiter } from "../lib/http.js";
import { SchemaError, validateCandles } from "./schema.js";
import { KST_OFFSET_MS } from "../lib/time.js";
import { num, parseYmdToKstEpoch } from "./naver.js";

const SOURCE = "krx";
const ENDPOINT = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const limiter = new RateLimiter(2, 3);

/** KRX bld 식별자 — 변경 시 여기만 고친다. */
export const BLD = {
  /** 전종목 기본정보 (코스피/코스닥 주식) */
  STOCK_MASTER: "dbms/MDC/STAT/standard/MDCSTAT01901",
  /** 전종목 시세 (거래대금 포함) */
  STOCK_DAILY_ALL: "dbms/MDC/STAT/standard/MDCSTAT01501",
  /** 개별종목 시세 추이 (일봉 폴백) */
  STOCK_SERIES: "dbms/MDC/STAT/standard/MDCSTAT01701",
  /** ETF 전종목 기본정보 */
  ETF_MASTER: "dbms/MDC/STAT/standard/MDCSTAT04601",
  /** ETN 전종목 기본정보 */
  ETN_MASTER: "dbms/MDC/STAT/standard/MDCSTAT06401",
} as const;

const HEADERS: Record<string, string> = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Referer: "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader",
  "User-Agent": "Mozilla/5.0 (compatible; kr-stock-advisor/0.1)",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

async function post(bld: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const form = new URLSearchParams({ bld, ...params });
  const body = await fetchText(ENDPOINT, {
    source: SOURCE, limiter, timeoutMs: 15_000,
    init: { method: "POST", headers: HEADERS, body: form.toString() },
  });
  let json: unknown;
  try { json = JSON.parse(body); }
  catch { throw new SchemaError(SOURCE, `${ENDPOINT}#${bld}`, "JSON 파싱 실패", body.slice(0, 300)); }
  const obj = json as Record<string, unknown>;
  const rows = (obj["OutBlock_1"] ?? obj["output"] ?? obj["block1"]) as unknown;
  if (!Array.isArray(rows)) {
    throw new SchemaError(SOURCE, `${ENDPOINT}#${bld}`, `결과 배열(OutBlock_1|output) 없음. keys=${Object.keys(obj).join(",")}`, body.slice(0, 300));
  }
  if (rows.length === 0) {
    throw new SchemaError(SOURCE, `${ENDPOINT}#${bld}`, "0건 반환(§8.1-2 감지 대상)", body.slice(0, 300));
  }
  return rows as Record<string, unknown>[];
}

const str = (r: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) { const v = r[k]; if (typeof v === "string" && v.trim() !== "") return v.trim(); }
  return "";
};

function toMarket(raw: string, fallback: Market): Market {
  const s = raw.replace(/\s/g, "");
  if (s.includes("KOSPI") || s.includes("유가증권")) return "KOSPI";
  if (s.includes("KOSDAQ") || s.includes("코스닥")) return "KOSDAQ";
  if (s.includes("KONEX") || s.includes("코넥스")) return "KOSDAQ";
  return fallback;
}

/* ───────────── 종목마스터(§3.2-4) ───────────── */

export type MasterRow = StockSymbol & { listedAt: string | null };

export async function fetchStockMaster(): Promise<MasterRow[]> {
  const rows = await post(BLD.STOCK_MASTER, { mktId: "ALL", share: "1", csvxls_isNo: "false" });
  const out: MasterRow[] = [];
  for (const r of rows) {
    const code = str(r, "ISU_SRT_CD", "ISU_CD").slice(-6);
    const name = str(r, "ISU_ABBRV", "ISU_NM");
    if (!/^[0-9A-Z]{6}$/.test(code) || !name) continue;
    out.push({
      code, name,
      market: toMarket(str(r, "MKT_TP_NM", "MKT_NM"), "KOSPI"),
      providerKey: str(r, "ISU_CD") || undefined,
      listedAt: normDate(str(r, "LIST_DD")),
    });
  }
  if (out.length < 1000) {
    throw new SchemaError(SOURCE, BLD.STOCK_MASTER, `종목 수 이상 (${out.length}건) — 파싱 규칙 점검 필요`, "");
  }
  return out;
}

export async function fetchEtfEtnMaster(): Promise<MasterRow[]> {
  const out: MasterRow[] = [];
  for (const [bld, market] of [[BLD.ETF_MASTER, "ETF"], [BLD.ETN_MASTER, "ETN"]] as const) {
    let rows: Record<string, unknown>[];
    try { rows = await post(bld, { share: "1", csvxls_isNo: "false" }); }
    catch { continue; }  // ETF/ETN 은 보조 정보 — 실패해도 주식 마스터는 유지
    for (const r of rows) {
      const code = str(r, "ISU_SRT_CD", "ISU_CD").slice(-6);
      const name = str(r, "ISU_ABBRV", "ISU_NM");
      if (!/^[0-9A-Z]{6}$/.test(code) || !name) continue;
      out.push({ code, name, market, providerKey: str(r, "ISU_CD") || undefined, listedAt: normDate(str(r, "LIST_DD")) });
    }
  }
  return out;
}

/** 전종목 시세 — 거래대금(ACC_TRDVAL) 보강용. trdDd 는 YYYYMMDD(KST). */
export async function fetchAllQuotes(trdDd: string): Promise<{ code: string; close: number; tradingValue: number; statusNote: string }[]> {
  const rows = await post(BLD.STOCK_DAILY_ALL, { mktId: "ALL", trdDd, share: "1", money: "1", csvxls_isNo: "false" });
  const out: { code: string; close: number; tradingValue: number; statusNote: string }[] = [];
  for (const r of rows) {
    const code = str(r, "ISU_SRT_CD", "ISU_CD").slice(-6);
    if (!/^[0-9A-Z]{6}$/.test(code)) continue;
    out.push({
      code,
      close: num(str(r, "TDD_CLSPRC")) ?? 0,
      tradingValue: num(str(r, "ACC_TRDVAL")) ?? 0,
      statusNote: str(r, "MKT_STAT_NM", "ISU_STAT_NM"),
    });
  }
  return out;
}

/* ───────────── 일봉 폴백(§8.1-3) ───────────── */

/** isuCd 는 표준코드(ISU_CD, 예 KR7005930003). 없으면 단축코드로 시도한다. */
export async function fetchDailyFallback(isuCd: string, from: Date, to: Date): Promise<Candle[]> {
  const rows = await post(BLD.STOCK_SERIES, {
    isuCd, strtDd: ymdKst(from), endDd: ymdKst(to), share: "1", money: "1", csvxls_isNo: "false",
  });
  const candles: Candle[] = [];
  for (const r of rows) {
    const t = parseYmdToKstEpoch(str(r, "TRD_DD").replace(/[^0-9]/g, ""));
    if (t === null) continue;
    const o = num(str(r, "TDD_OPNPRC")), h = num(str(r, "TDD_HGPRC"));
    const l = num(str(r, "TDD_LWPRC")), c = num(str(r, "TDD_CLSPRC"));
    const v = num(str(r, "ACC_TRDVOL")), va = num(str(r, "ACC_TRDVAL"));
    if (o === null || h === null || l === null || c === null || v === null) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;  // 거래정지일은 0 으로 내려온다
    candles.push({ t, o, h, l, c, v, va: va ?? Math.round(c * v), adj: false });
  }
  candles.sort((a, b) => a.t - b.t);
  return validateCandles(SOURCE, BLD.STOCK_SERIES, candles, { minCount: 1 });
}

function normDate(s: string): string | null {
  const d = s.replace(/[^0-9]/g, "");
  if (d.length !== 8) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function ymdKst(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`;
}

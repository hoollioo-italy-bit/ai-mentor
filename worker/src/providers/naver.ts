/**
 * 네이버 금융 어댑터 (1차 구현).
 *
 * ⚠ UNVERIFIED — 이 어댑터의 응답 구조는 **실호출로 검증되지 않았다.**
 *   본 코드가 작성된 실행 환경의 네트워크 정책이 아래 호스트를 차단한다:
 *     api.finance.naver.com, fchart.stock.naver.com  → CONNECT 403 (policy denial)
 *   따라서 파싱 규칙은 공개적으로 알려진 응답 형태에 기반한 **가설**이다.
 *   운영 투입 전 반드시 `scripts/verify-provider.ts` 를 로컬에서 실행해
 *   실제 응답과 대조하고, 어긋나는 지점을 이 파일에서 수정하십시오.
 *   가설이 틀려도 §3.2-3 스키마 검증이 예외를 던지고 §8.1-2 알림이 발송되므로
 *   잘못된 데이터가 분석에 조용히 유입되지는 않는다.
 *
 * 소스 제약
 *  - 분봉은 1분봉만 제공 → 5분·30분봉은 1분봉 합성(aggregate.resampleMinutes).
 *  - 거래대금(va)을 직접 주지 않음 → 일봉은 KRX 로 보강, 분봉은 종가×거래량 근사.
 *  - 수정주가 반영 여부가 공식적으로 명시되지 않음 → adj=true 로 기록하되 §3.3 참조.
 */

import type { Candle, Interval, PriceProvider, StockSymbol } from "@app/shared";
import { fetchText, RateLimiter, UpstreamError } from "../lib/http.js";
import { SchemaError, validateCandles, quoteSchema } from "./schema.js";
import { resampleMinutes, resampleDaily } from "./aggregate.js";
import { KST_OFFSET_MS } from "../lib/time.js";

const SOURCE = "naver";
const UA = "Mozilla/5.0 (compatible; kr-stock-advisor/0.1)";

/** 소스별 초당 호출 상한(§8.1-4) */
const limiter = new RateLimiter(3, 5);

const HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Referer: "https://finance.naver.com/",
  Accept: "*/*",
};

export type NaverDeps = { searchSymbols: (keyword: string) => Promise<StockSymbol[]> };

export function createNaverProvider(deps: NaverDeps): PriceProvider {
  return {
    searchSymbols: deps.searchSymbols,
    getCandles: (code, interval, from, to) => getCandles(code, interval, from, to),
    getQuote: (code) => getQuote(code),
  };
}

/* ───────────────────────── 시세 ───────────────────────── */

async function getCandles(code: string, interval: Interval, from: Date, to: Date): Promise<Candle[]> {
  if (interval === "1m" || interval === "5m" || interval === "30m") {
    const minutes = interval === "1m" ? 1 : interval === "5m" ? 5 : 30;
    const spanMinutes = Math.ceil((to.getTime() - from.getTime()) / 60_000);
    // 정규장은 하루 381분. 여유 20% 를 둔 뒤 소스 상한(1,000)으로 자른다.
    const count = Math.min(1000, Math.max(100, Math.ceil(spanMinutes * 0.3)));
    const raw = await fetchMinuteXml(code, count);
    const ones = raw.filter((c) => c.t >= from.getTime() && c.t <= to.getTime());
    return minutes === 1 ? ones : resampleMinutes(ones, minutes);
  }
  if (interval === "1d") return fetchDaily(code, from, to, "day");
  if (interval === "1w") {
    const weekly = await fetchDaily(code, from, to, "week").catch(() => null);
    if (weekly && weekly.length > 0) return weekly;
    return resampleDaily(await fetchDaily(code, from, to, "day"), "1w");
  }
  const monthly = await fetchDaily(code, from, to, "month").catch(() => null);
  if (monthly && monthly.length > 0) return monthly;
  return resampleDaily(await fetchDaily(code, from, to, "day"), "1M");
}

/**
 * 일/주/월봉.
 * GET https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1
 *     &startTime=YYYYMMDD&endTime=YYYYMMDD&timeframe=day|week|month
 *
 * 응답은 JSON 이 아니라 **작은따옴표를 쓰는 JS 배열 리터럴**이다(가설):
 *   [['날짜','시가','고가','저가','종가','거래량','외국인소진율'],
 *    ['20240102', 79600, 79800, 78200, 79600, 17142847, 54.13], ...]
 */
async function fetchDaily(code: string, from: Date, to: Date, timeframe: "day" | "week" | "month"): Promise<Candle[]> {
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}` +
    `&requestType=1&startTime=${ymd(from)}&endTime=${ymd(to)}&timeframe=${timeframe}`;
  const body = await fetchText(url, { source: SOURCE, limiter, init: { headers: HEADERS } });
  const rows = parseJsArrayLiteral(body, url);
  if (rows.length < 2) throw new SchemaError(SOURCE, url, `행 수 부족 (${rows.length})`, body.slice(0, 300));

  const header = rows[0]!.map(String);
  const idx = {
    date: findCol(header, ["날짜"]),
    o: findCol(header, ["시가"]),
    h: findCol(header, ["고가"]),
    l: findCol(header, ["저가"]),
    c: findCol(header, ["종가"]),
    v: findCol(header, ["거래량"]),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new SchemaError(SOURCE, url, `헤더에 '${k}' 컬럼 없음: ${header.join(",")}`, body.slice(0, 300));
  }

  const candles: Candle[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const dateRaw = String(r[idx.date] ?? "");
    const t = parseYmdToKstEpoch(dateRaw);
    if (t === null) continue;
    const o = num(r[idx.o]), h = num(r[idx.h]), l = num(r[idx.l]), c = num(r[idx.c]), v = num(r[idx.v]);
    if (o === null || h === null || l === null || c === null || v === null) continue;
    candles.push({ t, o, h, l, c, v, va: Math.round(c * v), adj: true });
  }
  candles.sort((a, b) => a.t - b.t);
  return validateCandles(SOURCE, url, candles, { minCount: 1, bodyHead: body.slice(0, 300) });
}

/**
 * 1분봉.
 * GET https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=minute&count={n}&requestType=0
 *
 * 응답은 XML(가설):
 *   <chartdata ...><item data="202401020901|79000|79100|78900|79000|12345"/>...</chartdata>
 *   data = 일시(YYYYMMDDHHmm) | 시가 | 고가 | 저가 | 종가 | 거래량
 */
async function fetchMinuteXml(code: string, count: number): Promise<Candle[]> {
  const url =
    `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}` +
    `&timeframe=minute&count=${count}&requestType=0`;
  const body = await fetchText(url, { source: SOURCE, limiter, init: { headers: HEADERS } });

  const items = [...body.matchAll(/data="([^"]+)"/g)].map((m) => m[1]!);
  if (items.length === 0) {
    throw new SchemaError(SOURCE, url, "item[data] 노드를 찾지 못함 (응답 형식 변경 가능성)", body.slice(0, 300));
  }
  const candles: Candle[] = [];
  for (const raw of items) {
    const parts = raw.split("|");
    if (parts.length < 6) continue;
    const t = parseYmdHmToKstEpoch(parts[0]!);
    if (t === null) continue;
    const o = num(parts[1]), h = num(parts[2]), l = num(parts[3]), c = num(parts[4]), v = num(parts[5]);
    if (o === null || h === null || l === null || c === null || v === null) continue;
    candles.push({ t, o, h, l, c, v, va: Math.round(c * v), adj: true });
  }
  candles.sort((a, b) => a.t - b.t);
  return validateCandles(SOURCE, url, candles, { minCount: 1, bodyHead: body.slice(0, 300) });
}

/**
 * 현재가.
 * GET https://polling.finance.naver.com/api/realtime/domestic/stock/{code}
 * 응답(가설): { resultCode:"success", datas:[{ closePrice:"79,600",
 *   compareToPreviousClosePrice:"600", fluctuationsRatio:"0.76", ... }] }
 */
async function getQuote(code: string): Promise<{ price: number; change: number; changeRate: number; t: number }> {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${encodeURIComponent(code)}`;
  const body = await fetchText(url, { source: SOURCE, limiter, init: { headers: HEADERS } });
  let json: unknown;
  try { json = JSON.parse(body); }
  catch { throw new SchemaError(SOURCE, url, "JSON 파싱 실패", body.slice(0, 300)); }

  const datas = (json as { datas?: unknown[] }).datas;
  if (!Array.isArray(datas) || datas.length === 0) {
    throw new SchemaError(SOURCE, url, "datas 배열이 비어 있음", body.slice(0, 300));
  }
  const d = datas[0] as Record<string, unknown>;
  const quote = {
    price: num(d["closePrice"]) ?? NaN,
    change: num(d["compareToPreviousClosePrice"]) ?? NaN,
    changeRate: num(d["fluctuationsRatio"]) ?? NaN,
    t: Date.now(),
  };
  const parsed = quoteSchema.safeParse(quote);
  if (!parsed.success) {
    throw new SchemaError(SOURCE, url, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), body.slice(0, 300));
  }
  // 하락 종목은 부호가 생략되는 경우가 있어 등락률 부호로 보정한다.
  if (parsed.data.changeRate < 0 && parsed.data.change > 0) parsed.data.change = -parsed.data.change;
  return parsed.data;
}

/* ───────────────────────── 파싱 유틸 ───────────────────────── */

/** 작은따옴표 JS 배열 리터럴 → 2차원 배열. */
export function parseJsArrayLiteral(body: string, url: string): unknown[][] {
  const cleaned = body
    .replace(/\r?\n|\t/g, " ")
    .replace(/'/g, '"')
    .replace(/,\s*]/g, "]")
    .trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { throw new SchemaError(SOURCE, url, `배열 리터럴 파싱 실패: ${String(e)}`, body.slice(0, 300)); }
  if (!Array.isArray(parsed)) throw new SchemaError(SOURCE, url, "최상위가 배열이 아님", body.slice(0, 300));
  return parsed.filter(Array.isArray) as unknown[][];
}

export function findCol(header: string[], names: string[]): number {
  return header.findIndex((h) => names.some((n) => h.replace(/\s/g, "").includes(n)));
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/,/g, "").replace(/[%원]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "YYYYMMDD" (KST 자정) → epoch ms */
export function parseYmdToKstEpoch(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET_MS;
}

/** "YYYYMMDDHHmm" (KST) → epoch ms */
export function parseYmdHmToKstEpoch(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - KST_OFFSET_MS;
}

function ymd(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`;
}

export const __naverInternals = { parseJsArrayLiteral, parseYmdToKstEpoch, parseYmdHmToKstEpoch, num, findCol };
export { UpstreamError };

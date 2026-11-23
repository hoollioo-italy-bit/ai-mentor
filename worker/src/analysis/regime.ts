/**
 * F5-5 시장 국면 — 코스피/코스닥 지수 추세 + 종목의 지수 대비 상대강도(RS).
 * 헤더에 상시 노출되므로 요청 경로에서 계산하지 않고 KV 캐시를 읽는다(§2.2-1).
 */

import type { Candle, MarketRegime, Market, TrendState } from "@app/shared";
import type { Env } from "../lib/env.js";
import { sma } from "../indicators/core.js";
import { readCandles } from "../providers/index.js";
import { kstYmd } from "../lib/time.js";

export const REGIME_KEY = (ymd: string) => `regime:${ymd}`;
export const INDEX_CODES = { KOSPI: "KOSPI", KOSDAQ: "KOSDAQ" } as const;

export const RS_WINDOW_DAYS = 60;

type IndexStat = { trend: TrendState; close: number; changeRate: number; ma20: number | null; ma60: number | null; series: number[] };

function judgeIndex(candles: Candle[]): IndexStat {
  const closes = candles.map((c) => c.c);
  const n = closes.length;
  const ma20 = sma(closes, 20)[n - 1] ?? null;
  const ma60 = sma(closes, 60)[n - 1] ?? null;
  const close = closes[n - 1] ?? 0;
  const prev = closes[n - 2] ?? close;
  let trend: TrendState = "SIDEWAYS";
  if (ma20 != null && ma60 != null) {
    if (close > ma20 && ma20 > ma60) trend = "UP";
    else if (close < ma20 && ma20 < ma60) trend = "DOWN";
  }
  return { trend, close, changeRate: prev ? ((close - prev) / prev) * 100 : 0, ma20, ma60, series: closes };
}

const label = (t: TrendState): string => (t === "UP" ? "상승" : t === "DOWN" ? "하락" : "횡보");

/** Cron 에서 호출 — 지수 통계를 KV 에 하루 단위로 저장한다. */
export async function computeRegimeBase(env: Env, now = Date.now()): Promise<{ kospi: IndexStat; kosdaq: IndexStat; asOf: number }> {
  const from = now - 400 * 86_400_000;
  const [kospi, kosdaq] = await Promise.all([
    readCandles(env, INDEX_CODES.KOSPI, "1d", from, now, 400),
    readCandles(env, INDEX_CODES.KOSDAQ, "1d", from, now, 400),
  ]);
  return { kospi: judgeIndex(kospi), kosdaq: judgeIndex(kosdaq), asOf: now };
}

export async function cacheRegime(env: Env, now = Date.now()): Promise<void> {
  const base = await computeRegimeBase(env, now);
  // RS 계산용 지수 종가 꼬리만 보관(용량 절약)
  const trim = (s: IndexStat) => ({ ...s, series: s.series.slice(-(RS_WINDOW_DAYS + 5)) });
  await env.KV.put(REGIME_KEY(kstYmd(now)), JSON.stringify({ kospi: trim(base.kospi), kosdaq: trim(base.kosdaq), asOf: base.asOf }), {
    expirationTtl: 3 * 86_400,
  });
}

export async function loadRegimeBase(env: Env, now = Date.now()): Promise<{ kospi: IndexStat; kosdaq: IndexStat; asOf: number } | null> {
  const today = await env.KV.get<{ kospi: IndexStat; kosdaq: IndexStat; asOf: number }>(REGIME_KEY(kstYmd(now)), "json");
  if (today) return today;
  const yesterday = await env.KV.get<{ kospi: IndexStat; kosdaq: IndexStat; asOf: number }>(REGIME_KEY(kstYmd(now - 86_400_000)), "json");
  return yesterday;
}

/**
 * 상대강도(RS) — 동일 기간 종목 수익률 ÷ 지수 수익률 (1.0 = 지수와 동일).
 * 둘 중 하나라도 표본이 모자라면 null (수치를 만들지 않는다).
 */
export function relativeStrength(stockCloses: number[], indexCloses: number[], window = RS_WINDOW_DAYS): number | null {
  if (stockCloses.length < window + 1 || indexCloses.length < window + 1) return null;
  const s0 = stockCloses[stockCloses.length - 1 - window]!;
  const s1 = stockCloses[stockCloses.length - 1]!;
  const i0 = indexCloses[indexCloses.length - 1 - window]!;
  const i1 = indexCloses[indexCloses.length - 1]!;
  if (s0 <= 0 || i0 <= 0) return null;
  const sr = s1 / s0;
  const ir = i1 / i0;
  if (ir === 0) return null;
  return sr / ir;
}

export async function buildRegime(
  env: Env, market: Market, stockDailyCloses: number[], now = Date.now(),
): Promise<MarketRegime> {
  const base = (await loadRegimeBase(env, now)) ?? (await computeRegimeBase(env, now));
  const isKosdaq = market === "KOSDAQ";
  const ref = isKosdaq ? base.kosdaq : base.kospi;
  const rs = relativeStrength(stockDailyCloses, ref.series);
  const refName = isKosdaq ? "코스닥" : "코스피";

  const rsText = rs === null
    ? `${refName} 대비 상대강도는 표본 부족으로 산출하지 않습니다`
    : `${refName} 대비 상대강도 ${rs.toFixed(2)} (${rs >= 1 ? "지수 상회" : "지수 하회"})`;

  return {
    kospi: { trend: base.kospi.trend, close: base.kospi.close, changeRate: base.kospi.changeRate, ma20: base.kospi.ma20, ma60: base.kospi.ma60 },
    kosdaq: { trend: base.kosdaq.trend, close: base.kosdaq.close, changeRate: base.kosdaq.changeRate, ma20: base.kosdaq.ma20, ma60: base.kosdaq.ma60 },
    rs,
    rsWindowDays: RS_WINDOW_DAYS,
    text: `코스피 ${label(base.kospi.trend)} · 코스닥 ${label(base.kosdaq.trend)} — ${rsText}`,
    asOf: base.asOf,
  };
}

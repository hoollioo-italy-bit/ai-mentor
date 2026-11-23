import type { Candle, IndicatorSeries, IndicatorSnapshot, Interval, SeriesPoint } from "@app/shared";
import { atr, bollinger, lastDefined, macd, rsi, sma, vwap, type Num } from "../indicators/core.js";
import { isIntraday } from "../providers/aggregate.js";
import { sessionKeyOf } from "../lib/time.js";

export type Cols = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; va: number[] };

export function toCols(candles: Candle[]): Cols {
  return {
    t: candles.map((x) => x.t), o: candles.map((x) => x.o), h: candles.map((x) => x.h),
    l: candles.map((x) => x.l), c: candles.map((x) => x.c), v: candles.map((x) => x.v),
    va: candles.map((x) => x.va ?? x.c * x.v),
  };
}

function points(t: number[], values: Num[]): SeriesPoint[] {
  return t.map((ts, i) => ({ t: ts, v: values[i] ?? null }));
}

export const MA_PERIODS = [5, 20, 60, 120, 200] as const;

export type Computed = {
  cols: Cols;
  ma: Record<number, Num[]>;
  rsi14: Num[];
  macd: ReturnType<typeof macd>;
  bb: ReturnType<typeof bollinger>;
  atr14: Num[];
  vwap: Num[];
  volMa20: Num[];
};

/** 지표 일괄 산출. Cron 사전 계산 경로에서만 호출한다(§2.2-1). */
export function computeAll(candles: Candle[], interval: Interval): Computed {
  const cols = toCols(candles);
  const ma: Record<number, Num[]> = {};
  for (const p of MA_PERIODS) ma[p] = sma(cols.c, p);
  return {
    cols,
    ma,
    rsi14: rsi(cols.c, 14),
    macd: macd(cols.c, 12, 26, 9),
    bb: bollinger(cols.c, 20, 2),
    atr14: atr(cols.h, cols.l, cols.c, 14),
    vwap: vwap(cols.h, cols.l, cols.c, cols.v, (i) => (isIntraday(interval) ? sessionKeyOf(cols.t[i]!) : "all")),
    volMa20: sma(cols.v, 20),
  };
}

/** 프론트 전달용 시계열. 장기 이평은 데이터가 모자라면(=상장 1년 미만, S6) 아예 싣지 않는다. */
export function toSeries(k: Computed, opts: { longHistory: boolean; prevClose: number | null }): IndicatorSeries {
  const t = k.cols.t;
  const maOut: Record<string, SeriesPoint[]> = {};
  for (const p of MA_PERIODS) {
    if (!opts.longHistory && p >= 120) continue;
    const arr = k.ma[p]!;
    if (arr.some((x) => x !== null)) maOut[`ma${p}`] = points(t, arr);
  }
  return {
    ma: maOut,
    vwap: points(t, k.vwap),
    rsi: points(t, k.rsi14),
    macd: { macd: points(t, k.macd.macd), signal: points(t, k.macd.signal), hist: points(t, k.macd.hist) },
    bollinger: {
      upper: points(t, k.bb.upper), mid: points(t, k.bb.mid),
      lower: points(t, k.bb.lower), bandwidth: points(t, k.bb.bandwidth),
    },
    atr: points(t, k.atr14),
    prevClose: opts.prevClose,
  };
}

/** signals.indicators 에 박제되는 스냅샷 — 사후 채점의 재현성 근거(F9). */
export function snapshot(k: Computed, rs: number | null, avgTradingValue20: number | null): IndicatorSnapshot {
  const n = k.cols.c.length;
  const i = n - 1;
  const ma: Record<string, number | null> = {};
  for (const p of MA_PERIODS) ma[`ma${p}`] = at(k.ma[p]!, i);
  const vol = k.cols.v[i] ?? 0;
  const vma = at(k.volMa20, i);
  return {
    close: k.cols.c[i] ?? 0,
    ma,
    rsi14: at(k.rsi14, i),
    macd: { macd: at(k.macd.macd, i), signal: at(k.macd.signal, i), hist: at(k.macd.hist, i) },
    bollinger: {
      upper: at(k.bb.upper, i), mid: at(k.bb.mid, i), lower: at(k.bb.lower, i),
      bandwidth: at(k.bb.bandwidth, i), pctB: at(k.bb.pctB, i),
    },
    atr14: at(k.atr14, i),
    vwap: at(k.vwap, i),
    volume: vol,
    volumeRatio20: vma && vma > 0 ? vol / vma : null,
    avgTradingValue20,
    rs,
  };
}

function at(arr: Num[], i: number): number | null {
  const v = arr[i];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

export { lastDefined };

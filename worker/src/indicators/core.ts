/**
 * 지표 계산 — 순수 함수. 외부 의존 없음. 단위 테스트 대상(§8.2).
 * 모든 함수는 입력 배열과 동일 길이의 배열을 반환하며, 워밍업 구간은 null 이다.
 */

export type Num = number | null;

export function sma(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 표준 EMA. 시드는 첫 period 개의 단순평균(SMA). */
export function ema(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 평활(RMA). ATR·RSI 의 내부 평균에 사용. */
export function rma(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** 모표준편차(population). 볼린저 밴드 표준 정의. */
export function stdev(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j]!;
    mean /= period;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j]! - mean;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): Num[] {
  const out: Num[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i]!;
    avgLoss += losses[i]!;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export type MacdOut = { macd: Num[]; signal: Num[]; hist: Num[] };

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdOut {
  const n = closes.length;
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Num[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = ef[i];
    const b = es[i];
    line[i] = a !== null && a !== undefined && b !== null && b !== undefined ? a - b : null;
  }
  // signal 은 macd line 의 유효 구간만으로 EMA 를 계산한 뒤 원 위치에 되돌린다.
  const firstValid = line.findIndex((x) => x !== null);
  const signal: Num[] = new Array(n).fill(null);
  const hist: Num[] = new Array(n).fill(null);
  if (firstValid >= 0) {
    const compact = line.slice(firstValid) as number[];
    const sig = ema(compact, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      const s = sig[i];
      if (s === null || s === undefined) continue;
      const idx = firstValid + i;
      signal[idx] = s;
      const m = line[idx];
      hist[idx] = m !== null && m !== undefined ? m - s : null;
    }
  }
  return { macd: line, signal, hist };
}

export type BollingerOut = { upper: Num[]; mid: Num[]; lower: Num[]; bandwidth: Num[]; pctB: Num[] };

export function bollinger(closes: number[], period = 20, mult = 2): BollingerOut {
  const n = closes.length;
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  const upper: Num[] = new Array(n).fill(null);
  const lower: Num[] = new Array(n).fill(null);
  const bandwidth: Num[] = new Array(n).fill(null);
  const pctB: Num[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = mid[i];
    const s = sd[i];
    if (m === null || m === undefined || s === null || s === undefined) continue;
    const u = m + mult * s;
    const l = m - mult * s;
    upper[i] = u;
    lower[i] = l;
    bandwidth[i] = m === 0 ? 0 : (u - l) / m;
    pctB[i] = u - l === 0 ? 0.5 : (closes[i]! - l) / (u - l);
  }
  return { upper, mid, lower, bandwidth, pctB };
}

/** Wilder ATR. */
export function atr(high: number[], low: number[], close: number[], period = 14): Num[] {
  const n = close.length;
  if (n === 0) return [];
  const tr: number[] = new Array(n).fill(0);
  tr[0] = high[0]! - low[0]!;
  for (let i = 1; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    const pc = close[i - 1]!;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = rma(tr, period);
  // TR[0] 은 전일 종가가 없어 정의가 불완전하므로 워밍업 첫 값은 버린다.
  return out;
}

/**
 * VWAP. 세션 경계(sessionKey 가 바뀌는 지점)에서 누적을 리셋한다.
 * 일봉 이상에서는 sessionKey 를 전부 동일하게 주어 누적 VWAP 로 쓸 수 있다.
 */
export function vwap(
  high: number[], low: number[], close: number[], volume: number[], sessionKey: (i: number) => string,
): Num[] {
  const n = close.length;
  const out: Num[] = new Array(n).fill(null);
  let cumPV = 0;
  let cumV = 0;
  let cur: string | null = null;
  for (let i = 0; i < n; i++) {
    const key = sessionKey(i);
    if (key !== cur) { cur = key; cumPV = 0; cumV = 0; }
    const tp = (high[i]! + low[i]! + close[i]!) / 3;
    const v = volume[i] ?? 0;
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

/** 단순 선형회귀. x 는 0..n-1 인덱스. */
export function linreg(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: points[0]!.y };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

export type Pivot = { index: number; price: number };

/** 좌우 `span` 개 봉 중 최고/최저인 지점. */
export function pivotHighs(high: number[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < high.length - span; i++) {
    const v = high[i]!;
    let ok = true;
    for (let j = i - span; j <= i + span; j++) { if (j !== i && high[j]! > v) { ok = false; break; } }
    if (ok) out.push({ index: i, price: v });
  }
  return out;
}

export function pivotLows(low: number[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < low.length - span; i++) {
    const v = low[i]!;
    let ok = true;
    for (let j = i - span; j <= i + span; j++) { if (j !== i && low[j]! < v) { ok = false; break; } }
    if (ok) out.push({ index: i, price: v });
  }
  return out;
}

export type Level = { price: number; touches: number; lastIndex: number };

/**
 * 피벗 가격을 `tolerance`(비율) 안에서 묶어 수평 레벨을 만든다.
 * 최소 `minTouches` 회 터치한 클러스터만 반환하며, 터치 수 내림차순으로 정렬한다.
 */
export function clusterLevels(pivots: Pivot[], tolerance = 0.012, minTouches = 2): Level[] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups: Pivot[][] = [];
  let cur: Pivot[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    const base = cur[0]!.price;
    if (base > 0 && Math.abs(p.price - base) / base <= tolerance) cur.push(p);
    else { groups.push(cur); cur = [p]; }
  }
  groups.push(cur);
  return groups
    .filter((g) => g.length >= minTouches)
    .map((g) => ({
      price: g.reduce((s, p) => s + p.price, 0) / g.length,
      touches: g.length,
      lastIndex: Math.max(...g.map((p) => p.index)),
    }))
    .sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex);
}

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 1] as const;

/** 스윙 고점→저점 구간의 되돌림 레벨. */
export function fibonacci(swingHigh: number, swingLow: number): { ratio: number; price: number }[] {
  const diff = swingHigh - swingLow;
  return FIB_RATIOS.map((r) => ({ ratio: r, price: swingHigh - diff * r }));
}

export function lastDefined(arr: Num[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

export function at(arr: Num[], i: number): number | null {
  const v = arr[i];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

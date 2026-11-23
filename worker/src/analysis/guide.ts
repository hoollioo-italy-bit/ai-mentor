/**
 * F6 투자 가이드 (3점 세트).
 * §1.1 에 따라 "매수/매도" 같은 단정적 권유 표현을 쓰지 않는다.
 * entry/stop/target 은 **가격 수준**이며, 행동 지시가 아니다.
 */

import {
  MIN_RR, MIN_SAMPLE, RISK_PER_TRADE,
  type Annotation, type Confidence, type Guide, type IndicatorSnapshot,
  type SafetyFlag, type SignalStat, type SignalType,
} from "@app/shared";
import type { Computed } from "./series.js";
import { lastSwing } from "./annotations.js";
import { isBlocked } from "./safety.js";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

/* ───────────── 시그널 유형 판정 ───────────── */

/** 가장 최근 봉에서 성립한 시그널 1개를 고른다(우선순위 순). 없으면 NONE. */
export function detectSignal(k: Computed, s: IndicatorSnapshot, annotations: Annotation[]): SignalType {
  const n = k.cols.c.length;
  const i = n - 1;
  const recent = (t: number): boolean => n >= 5 && t >= k.cols.t[Math.max(0, n - 5)]!;

  const cross = annotations.find((a): a is Extract<Annotation, { kind: "MA_CROSS" }> => a.kind === "MA_CROSS" && recent(a.t));
  if (cross) return cross.cross === "GOLDEN" ? "GOLDEN_CROSS" : "DEAD_CROSS";

  const m0 = k.macd.hist[i - 1], m1 = k.macd.hist[i];
  if (m0 != null && m1 != null) {
    if (m0 <= 0 && m1 > 0) return "MACD_BULL_CROSS";
    if (m0 >= 0 && m1 < 0) return "MACD_BEAR_CROSS";
  }

  if (s.rsi14 != null) {
    if (s.rsi14 <= 30) return "RSI_OVERSOLD";
    if (s.rsi14 >= 70) return "RSI_OVERBOUGHT";
  }

  const squeeze = annotations.find((a): a is Extract<Annotation, { kind: "BB_SQUEEZE" }> => a.kind === "BB_SQUEEZE");
  if (squeeze && s.bollinger.pctB != null && (s.bollinger.pctB > 1 || s.bollinger.pctB < 0)) return "BB_SQUEEZE_BREAK";
  if (s.bollinger.pctB != null && s.bollinger.pctB <= 0.05) return "BB_LOWER_TOUCH";

  const res = annotations.find((a): a is Extract<Annotation, { kind: "RESISTANCE" }> => a.kind === "RESISTANCE");
  if (res && s.close > res.price && (s.volumeRatio20 ?? 0) >= 1.5) return "RESISTANCE_BREAK";

  const sup = annotations.find((a): a is Extract<Annotation, { kind: "SUPPORT" }> => a.kind === "SUPPORT");
  if (sup && Math.abs(s.close - sup.price) / s.close <= 0.015) return "SUPPORT_RETEST";

  if ((s.volumeRatio20 ?? 0) >= 2 && n >= 2 && k.cols.c[i]! > k.cols.c[i - 1]!) return "VOLUME_BREAKOUT";
  return "NONE";
}

/* ───────────── 3점 세트 산출 ───────────── */

export type GuideInput = {
  k: Computed;
  snapshot: IndicatorSnapshot;
  annotations: Annotation[];
  safety: SafetyFlag[];
  stat: SignalStat | null;
  /** 최대손실액 환산 기준 계좌 평가액(원) */
  accountValue: number;
};

export function buildGuide(input: GuideInput): Guide {
  const { k, snapshot: s, annotations, stat, accountValue } = input;
  const signalType = detectSignal(k, s, annotations);
  const confidence = toConfidence(stat);

  const levels = computeLevels(k, s, annotations);
  const safety = [...input.safety];

  if (!levels) {
    return {
      available: false, blockedBy: safety.filter((f) => f.blocking).length ? safety : null,
      message: "현재 조건에서 유리한 진입 구간 없음",
      signalType, entry: null, stopLoss: null, target: null, riskReward: null,
      suggestedWeightPct: null, maxLossAmount: null, confidence,
    };
  }

  const { entry, stopLoss, target } = levels;
  const risk = entry.mid - stopLoss.price;
  const reward = target.price - entry.mid;
  const riskReward = risk > 0 ? reward / risk : null;

  // S5 는 R:R 을 알아야 판정되므로 여기서 추가한다.
  if (riskReward !== null && riskReward < MIN_RR && !safety.some((f) => f.code === "S5")) {
    safety.push({
      code: "S5", blocking: true, badge: "손익비 미달",
      reason: `손익비 ${riskReward.toFixed(2)} < ${MIN_RR}`,
    });
  }

  if (riskReward === null || riskReward < MIN_RR) {
    return {
      available: false, blockedBy: safety, message: "현재 조건에서 유리한 진입 구간 없음",
      signalType, entry: null, stopLoss: null, target: null, riskReward,
      suggestedWeightPct: null, maxLossAmount: null, confidence,
    };
  }

  if (isBlocked(safety)) {
    return {
      available: false, blockedBy: safety,
      message: "안전장치 발동 — 가이드를 생성하지 않습니다.",
      signalType, entry: null, stopLoss: null, target: null, riskReward,
      suggestedWeightPct: null, maxLossAmount: null, confidence,
    };
  }

  // 권장 비중: 계좌 대비 최대손실 2% 기준 역산
  const lossPerShareRate = risk / entry.mid;
  const weight = lossPerShareRate > 0 ? Math.min(1, RISK_PER_TRADE / lossPerShareRate) : null;
  const maxLossAmount = weight !== null ? Math.round(accountValue * weight * lossPerShareRate) : null;

  return {
    available: true, blockedBy: null, message: null, signalType,
    entry: { low: entry.low, high: entry.high, basis: entry.basis },
    stopLoss: { price: stopLoss.price, basis: stopLoss.basis },
    target: { price: target.price, basis: target.basis },
    riskReward,
    suggestedWeightPct: weight !== null ? Number((weight * 100).toFixed(1)) : null,
    maxLossAmount,
    confidence,
  };
}

type Levels = {
  entry: { low: number; high: number; mid: number; basis: string };
  stopLoss: { price: number; basis: string };
  target: { price: number; basis: string };
};

export function computeLevels(k: Computed, s: IndicatorSnapshot, annotations: Annotation[]): Levels | null {
  const close = s.close;
  if (!Number.isFinite(close) || close <= 0) return null;

  /* 진입 구간 — 현재가 기준 지지선·이평 근접 구간 */
  const supports = annotations
    .filter((a): a is Extract<Annotation, { kind: "SUPPORT" }> => a.kind === "SUPPORT")
    .map((a) => a.price);
  const maCandidates = [s.ma["ma20"], s.ma["ma60"]].filter((x): x is number => x != null && x < close * 1.02);
  const anchors = [...supports, ...maCandidates].filter((p) => p > 0 && p <= close * 1.02);

  const atrVal = s.atr14 ?? close * 0.02;
  let entryLow: number;
  let entryHigh: number;
  let entryBasis: string;

  if (anchors.length > 0) {
    const anchor = Math.max(...anchors);
    entryLow = Math.min(anchor, close);
    entryHigh = Math.max(anchor, Math.min(close, anchor * 1.01));
    entryBasis = supports.includes(anchor)
      ? `지지 ${won(anchor)} 근접 구간`
      : `${anchor === s.ma["ma20"] ? "20일" : "60일"} 이평 ${won(anchor)} 근접 구간`;
  } else {
    entryLow = close - atrVal * 0.5;
    entryHigh = close;
    entryBasis = `현재가 ~ ATR 0.5배 아래 구간 (지지 근거 없음)`;
  }
  if (entryHigh <= entryLow) entryHigh = entryLow * 1.001;
  const mid = (entryLow + entryHigh) / 2;

  /* 손절가 — 직전 스윙 저점 하단 또는 ATR × 1.5 중 더 보수적인(가까운) 쪽 */
  const swing = lastSwing(k.cols.h, k.cols.l, k.cols.c.length > 400 ? 5 : 3);
  const swingStop = swing ? swing.low.price * 0.995 : null;
  const atrStop = mid - atrVal * 1.5;
  let stopPrice: number;
  let stopBasis: string;
  if (swingStop !== null && swingStop < mid && swingStop >= atrStop) {
    stopPrice = swingStop; stopBasis = `직전 스윙 저점 ${won(swing!.low.price)} 하단 0.5%`;
  } else {
    stopPrice = atrStop; stopBasis = `ATR(14) ${won(atrVal)} × 1.5`;
  }
  if (stopPrice >= mid) return null;

  /* 목표가 — 직전 저항선 또는 피보나치 레벨 중 현재가 위에서 가장 가까운 값 */
  const resistances = annotations
    .filter((a): a is Extract<Annotation, { kind: "RESISTANCE" }> => a.kind === "RESISTANCE")
    .map((a) => ({ price: a.price, basis: `저항 ${won(a.price)} (${a.touches}회 터치)` }));
  const fib = annotations.find((a): a is Extract<Annotation, { kind: "FIBONACCI" }> => a.kind === "FIBONACCI");
  const fibLevels = (fib?.levels ?? [])
    .filter((l) => l.price > mid)
    .map((l) => ({ price: l.price, basis: `피보나치 ${(l.ratio * 100).toFixed(1)}% ${won(l.price)}` }));
  const candidates = [...resistances, ...fibLevels].filter((x) => x.price > mid).sort((a, b) => a.price - b.price);
  if (candidates.length === 0) return null;
  const target = candidates[0]!;

  return {
    entry: { low: entryLow, high: entryHigh, mid, basis: entryBasis },
    stopLoss: { price: stopPrice, basis: stopBasis },
    target: { price: target.price, basis: target.basis },
  };
}

/** S3 — 표본 30건 미만이면 수치를 만들지 않는다. */
export function toConfidence(stat: SignalStat | null): Confidence {
  if (!stat || stat.sample < MIN_SAMPLE || stat.hitRate === null) {
    return { available: false, reason: `검증 표본 부족 — 참고 불가 (${stat?.sample ?? 0}/${MIN_SAMPLE}건)`, sample: stat?.sample ?? 0 };
  }
  return { available: true, hitRate: stat.hitRate, avgReturn: stat.avgReturn ?? 0, sample: stat.sample, horizonDays: stat.horizonDays };
}

import type { Candle, Interval, StockSymbol } from "./providers/types.js";
import type { Horizon, IndicatorKey } from "./horizon.js";

/* ───────────── 안전장치 (§1.2 S1~S7) ───────────── */

export type SafetyCode = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

/** blocking=true 이면 가이드 생성 자체가 차단된다(경고 문구가 아니라 기능 차단). */
export type SafetyFlag = {
  code: SafetyCode;
  /** true = 가이드 생성 차단 */
  blocking: boolean;
  /** 화면 배지 문구 */
  badge: string;
  /** 사유 상세 */
  reason: string;
};

export const SAFETY_BADGE: Record<SafetyCode, string> = {
  S1: "데이터 지연 — 판단 근거로 사용 불가",
  S2: "거래 유의 종목 — 가이드 생성 차단",
  S3: "검증 표본 부족 — 참고 불가",
  S4: "유동성 부족",
  S5: "손익비 미달",
  S6: "상장 1년 미만 — 장기 지표 미산출",
  S7: "단일 종목 비중 초과",
};

/* ───────────── 데이터 신선도 (S1 판정 입력) ───────────── */

export type Freshness = {
  /** LIVE = 1차 소스 정상, FALLBACK = 폴백 소스, STALE = D1 캐시 */
  state: "LIVE" | "FALLBACK" | "STALE";
  source: string;
  /** 마지막 봉 시각 (epoch ms) */
  lastBarAt: number | null;
  /** 데이터 생성 시각 (epoch ms) */
  fetchedAt: number;
  /** 지연 분(장중 기준). null = 판정 불가 */
  delayMinutes: number | null;
};

/* ───────────── F4 차트 주석 ───────────── */

export const ANNOTATION_COLOR = {
  support: "#2563EB",
  resistance: "#DC2626",
  trend: "#6B7280",
  signal: "#EA580C",
  event: "#7C3AED",
} as const;

export type AnnotationKind =
  | "SUPPORT" | "RESISTANCE" | "TRENDLINE" | "CHANNEL"
  | "FIBONACCI" | "MA_CROSS" | "BB_SQUEEZE" | "VOLUME_SPIKE" | "EVENT";

export type Annotation =
  | { kind: "SUPPORT"; price: number; touches: number; label: string; note: string }
  | { kind: "RESISTANCE"; price: number; touches: number; label: string; note: string }
  | { kind: "TRENDLINE"; p1: { t: number; price: number }; p2: { t: number; price: number }; slopePerBar: number; label: string; note: string }
  | { kind: "CHANNEL"; p1: { t: number; price: number }; p2: { t: number; price: number }; width: number; label: string; note: string }
  | { kind: "FIBONACCI"; swingHigh: { t: number; price: number }; swingLow: { t: number; price: number }; levels: { ratio: number; price: number }[]; label: string; note: string }
  | { kind: "MA_CROSS"; t: number; price: number; cross: "GOLDEN" | "DEAD"; fast: number; slow: number; label: string; note: string }
  | { kind: "BB_SQUEEZE"; from: number; to: number; label: string; note: string }
  | { kind: "VOLUME_SPIKE"; t: number; ratio: number; label: string; note: string }
  | { kind: "EVENT"; t: number; date: string; eventKind: string; memo: string; label: string; note: string };

/* ───────────── 지표 시계열 ───────────── */

export type SeriesPoint = { t: number; v: number | null };

export type IndicatorSeries = {
  ma?: Record<string, SeriesPoint[]>;
  vwap?: SeriesPoint[];
  rsi?: SeriesPoint[];
  macd?: { macd: SeriesPoint[]; signal: SeriesPoint[]; hist: SeriesPoint[] };
  bollinger?: { upper: SeriesPoint[]; mid: SeriesPoint[]; lower: SeriesPoint[]; bandwidth: SeriesPoint[] };
  atr?: SeriesPoint[];
  prevClose?: number | null;
};

/** 가이드/시그널 생성 시점에 박제되는 지표 스냅샷 (signals.indicators) */
export type IndicatorSnapshot = {
  close: number;
  ma: Record<string, number | null>;
  rsi14: number | null;
  macd: { macd: number | null; signal: number | null; hist: number | null };
  bollinger: { upper: number | null; mid: number | null; lower: number | null; bandwidth: number | null; pctB: number | null };
  atr14: number | null;
  vwap: number | null;
  volume: number;
  volumeRatio20: number | null;
  avgTradingValue20: number | null;
  rs: number | null;
};

/* ───────────── F5 해석 패널 ───────────── */

export type TrendState = "UP" | "SIDEWAYS" | "DOWN";
export type MomentumState = "OVERBOUGHT" | "STRONG" | "NEUTRAL" | "WEAK" | "OVERSOLD";
export type VolatilityState = "EXPANDING" | "NORMAL" | "SQUEEZE";
export type FlowState = "INFLOW" | "NEUTRAL" | "OUTFLOW";

export type Interpretation = {
  trend: { state: TrendState; text: string; evidence: string[] };
  momentum: { state: MomentumState; text: string; evidence: string[] };
  volatility: { state: VolatilityState; text: string; evidence: string[] };
  flow: { state: FlowState; text: string; evidence: string[] };
  /** 다중 시간프레임 상충 경고 (F3) */
  timeframeConflict: { conflict: boolean; text: string | null };
  /** §1.1 3요소 구조 종합 서술 */
  composite: {
    /** 1. 현재 상태 서술 */
    state: string;
    /** 2. 조건부 시나리오 */
    scenarios: string[];
    /** 3. 무효화 조건 */
    invalidation: string;
  };
};

/* ───────────── F5-5 시장 국면 ───────────── */

export type MarketRegime = {
  kospi: { trend: TrendState; close: number; changeRate: number; ma20: number | null; ma60: number | null };
  kosdaq: { trend: TrendState; close: number; changeRate: number; ma20: number | null; ma60: number | null };
  /** 종목의 소속 지수 대비 상대강도 (1.0 = 지수와 동일). null = 산출 불가 */
  rs: number | null;
  rsWindowDays: number;
  text: string;
  asOf: number;
};

/* ───────────── F6 투자 가이드 ───────────── */

export type SignalType =
  | "GOLDEN_CROSS" | "DEAD_CROSS"
  | "RSI_OVERSOLD" | "RSI_OVERBOUGHT"
  | "BB_SQUEEZE_BREAK" | "BB_LOWER_TOUCH"
  | "MACD_BULL_CROSS" | "MACD_BEAR_CROSS"
  | "SUPPORT_RETEST" | "RESISTANCE_BREAK"
  | "VOLUME_BREAKOUT"
  | "NONE";

export const SIGNAL_TYPE_LABEL: Record<SignalType, string> = {
  GOLDEN_CROSS: "골든크로스",
  DEAD_CROSS: "데드크로스",
  RSI_OVERSOLD: "RSI 과매도",
  RSI_OVERBOUGHT: "RSI 과매수",
  BB_SQUEEZE_BREAK: "볼린저 스퀴즈 이탈",
  BB_LOWER_TOUCH: "볼린저 하단 터치",
  MACD_BULL_CROSS: "MACD 상향 교차",
  MACD_BEAR_CROSS: "MACD 하향 교차",
  SUPPORT_RETEST: "지지선 재테스트",
  RESISTANCE_BREAK: "저항선 돌파",
  VOLUME_BREAKOUT: "거래량 동반 돌파",
  NONE: "해당 없음",
};

export type Confidence =
  | { available: false; reason: string; sample: number }
  | { available: true; hitRate: number; avgReturn: number; sample: number; horizonDays: number };

export type Guide = {
  available: boolean;
  /** available=false 일 때의 사유 (차단 안전장치 또는 R:R 미달) */
  blockedBy: SafetyFlag[] | null;
  /** R:R 1.5 미만 시 이 문구를 노출 */
  message: string | null;
  signalType: SignalType;
  entry: { low: number; high: number; basis: string } | null;
  stopLoss: { price: number; basis: string } | null;
  target: { price: number; basis: string } | null;
  riskReward: number | null;
  /** 계좌 대비 최대손실 2% 기준 역산 비중(%) */
  suggestedWeightPct: number | null;
  /** 손절 도달 시 손실 금액(원) — accountValue 입력 기준 */
  maxLossAmount: number | null;
  confidence: Confidence;
};

/* ───────────── analysis_cache.payload 전체 ───────────── */

export const DISCLAIMER =
  "본 정보는 투자 판단 참고용이며 투자 권유가 아닙니다. 투자 결과의 책임은 이용자 본인에게 있습니다.";

export type AnalysisPayload = {
  schemaVersion: 1;
  symbol: StockSymbol & { listedAt: string | null; avgTradingValue: number | null };
  horizon: Horizon;
  primary: { interval: Interval; candles: Candle[]; indicators: IndicatorSeries };
  higher: { interval: Interval; label: string; candles: Candle[]; indicators: IndicatorSeries; trend: TrendState };
  requestedIndicators: IndicatorKey[];
  annotations: Annotation[];
  snapshot: IndicatorSnapshot;
  interpretation: Interpretation;
  regime: MarketRegime;
  guide: Guide;
  safety: SafetyFlag[];
  freshness: Freshness;
  /** 지금까지 채점된 전체 시그널 건수와 적중률 (§1.2 검증 현황 배지) */
  verification: { scored: number; hitRate: number | null };
  disclaimer: string;
  computedAt: number;
};

/* ───────────── F9 적중률 집계 ───────────── */

export type ScoreResult = { ret: number; hitStop: boolean; hitTarget: boolean };

export type SignalStat = {
  signalType: SignalType;
  label: string;
  horizonDays: number;
  sample: number;
  hitRate: number | null;
  avgReturn: number | null;
  stopRate: number | null;
  /** S3: 표본 30건 미만이면 true — 신뢰도 수치를 만들지 말 것 */
  insufficient: boolean;
};

/** S3 기준 최소 표본 */
export const MIN_SAMPLE = 30;
/** S4 기준 일평균 거래대금(원) */
export const MIN_TRADING_VALUE = 3_000_000_000;
/** S5 기준 최소 손익비 */
export const MIN_RR = 1.5;
/** S7 기준 단일 종목 최대 비중 */
export const MAX_POSITION_WEIGHT = 0.20;
/** 계좌 대비 1회 최대손실 허용폭 (F6 권장 비중 역산) */
export const RISK_PER_TRADE = 0.02;

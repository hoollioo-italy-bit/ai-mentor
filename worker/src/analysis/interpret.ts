/**
 * F5 분석 해석 패널.
 *
 * 해석 문장은 **지표값 → 문장 템플릿(규칙 기반)** 으로만 생성한다(§F5 단서).
 * LLM 자유 생성을 쓰지 않는 이유: 재현성과 사후 채점이 불가능해지기 때문.
 *
 * §1.1 표현 제약 — 단정적 투자 권유 표현("매수하세요" 등)을 생성하지 않는다.
 * 허용 형식은 ①현재 상태 서술 ②조건부 시나리오 ③무효화 조건 뿐이다.
 */

import type {
  Annotation, FlowState, IndicatorSnapshot, Interpretation, MomentumState, TrendState, VolatilityState,
} from "@app/shared";
import type { Computed } from "./series.js";

const won = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;
const f1 = (n: number): string => n.toFixed(1);

/* ───────────── 추세 ───────────── */

export function judgeTrend(k: Computed): { state: TrendState; evidence: string[] } {
  const n = k.cols.c.length;
  const i = n - 1;
  const c = k.cols.c[i]!;
  const ma5 = k.ma[5]![i], ma20 = k.ma[20]![i], ma60 = k.ma[60]![i];
  const ev: string[] = [];
  let score = 0;

  if (ma5 != null && ma20 != null && ma60 != null) {
    if (ma5 > ma20 && ma20 > ma60) { score += 2; ev.push(`이평 정배열 (5일 ${won(ma5)} > 20일 ${won(ma20)} > 60일 ${won(ma60)})`); }
    else if (ma5 < ma20 && ma20 < ma60) { score -= 2; ev.push(`이평 역배열 (5일 ${won(ma5)} < 20일 ${won(ma20)} < 60일 ${won(ma60)})`); }
    else ev.push(`이평 혼조 (5일 ${won(ma5)}, 20일 ${won(ma20)}, 60일 ${won(ma60)})`);
  }
  if (ma20 != null) {
    if (c > ma20) { score += 1; ev.push(`종가가 20일 이평 위 ${f1(((c - ma20) / ma20) * 100)}%`); }
    else { score -= 1; ev.push(`종가가 20일 이평 아래 ${f1(((ma20 - c) / ma20) * 100)}%`); }
  }

  // 고점·저점 형성: 최근 구간을 반으로 나눠 고점/저점이 올라갔는지 본다.
  const look = Math.min(60, n);
  if (look >= 10) {
    const a = n - look, mid = n - Math.floor(look / 2);
    const h1 = Math.max(...k.cols.h.slice(a, mid)), h2 = Math.max(...k.cols.h.slice(mid));
    const l1 = Math.min(...k.cols.l.slice(a, mid)), l2 = Math.min(...k.cols.l.slice(mid));
    if (h2 > h1 && l2 > l1) { score += 1; ev.push("최근 구간 고점·저점 동반 상승"); }
    else if (h2 < h1 && l2 < l1) { score -= 1; ev.push("최근 구간 고점·저점 동반 하락"); }
    else ev.push("최근 구간 고점·저점 방향 불일치");
  }

  const state: TrendState = score >= 2 ? "UP" : score <= -2 ? "DOWN" : "SIDEWAYS";
  return { state, evidence: ev };
}

const TREND_TEXT: Record<TrendState, string> = {
  UP: "상승 추세로 판정됩니다",
  SIDEWAYS: "방향성이 확인되지 않는 횡보 구간입니다",
  DOWN: "하락 추세로 판정됩니다",
};

/* ───────────── 모멘텀 ───────────── */

export function judgeMomentum(s: IndicatorSnapshot): { state: MomentumState; evidence: string[] } {
  const ev: string[] = [];
  let state: MomentumState = "NEUTRAL";
  if (s.rsi14 != null) {
    ev.push(`RSI(14) ${s.rsi14.toFixed(1)}`);
    if (s.rsi14 >= 70) state = "OVERBOUGHT";
    else if (s.rsi14 <= 30) state = "OVERSOLD";
    else if (s.rsi14 >= 55) state = "STRONG";
    else if (s.rsi14 <= 45) state = "WEAK";
  } else ev.push("RSI 산출 불가 (데이터 부족)");

  const { macd, signal, hist } = s.macd;
  if (macd != null && signal != null && hist != null) {
    ev.push(`MACD ${macd.toFixed(1)} / 시그널 ${signal.toFixed(1)} / 히스토그램 ${hist >= 0 ? "+" : ""}${hist.toFixed(1)}`);
    if (hist > 0 && state === "NEUTRAL") state = "STRONG";
    if (hist < 0 && state === "NEUTRAL") state = "WEAK";
  } else ev.push("MACD 산출 불가 (데이터 부족)");
  return { state, evidence: ev };
}

const MOMENTUM_TEXT: Record<MomentumState, string> = {
  OVERBOUGHT: "모멘텀 과열 구간입니다",
  STRONG: "모멘텀이 우위에 있습니다",
  NEUTRAL: "모멘텀이 중립입니다",
  WEAK: "모멘텀이 약화된 상태입니다",
  OVERSOLD: "모멘텀 과매도 구간입니다",
};

/* ───────────── 변동성 ───────────── */

export function judgeVolatility(k: Computed, s: IndicatorSnapshot): { state: VolatilityState; evidence: string[] } {
  const ev: string[] = [];
  const bw = s.bollinger.bandwidth;
  let state: VolatilityState = "NORMAL";
  if (bw != null) {
    const hist = k.bb.bandwidth.filter((x): x is number => x !== null);
    const sorted = [...hist].sort((a, b) => a - b);
    const p20 = sorted[Math.floor(sorted.length * 0.2)] ?? bw;
    const p80 = sorted[Math.floor(sorted.length * 0.8)] ?? bw;
    const rank = sorted.length ? sorted.filter((x) => x <= bw).length / sorted.length : 0.5;
    ev.push(`볼린저 밴드폭 ${(bw * 100).toFixed(2)}% (구간 내 하위 ${Math.round(rank * 100)}%)`);
    if (bw <= p20) state = "SQUEEZE";
    else if (bw >= p80) state = "EXPANDING";
  } else ev.push("볼린저 밴드폭 산출 불가");
  if (s.atr14 != null && s.close > 0) ev.push(`ATR(14) ${won(s.atr14)} (종가 대비 ${f1((s.atr14 / s.close) * 100)}%)`);
  return { state, evidence: ev };
}

const VOL_TEXT: Record<VolatilityState, string> = {
  EXPANDING: "변동성이 확대된 구간입니다",
  NORMAL: "변동성은 평상 수준입니다",
  SQUEEZE: "변동성이 수축된 구간입니다",
};

/* ───────────── 수급 ───────────── */

export function judgeFlow(k: Computed, s: IndicatorSnapshot): { state: FlowState; evidence: string[] } {
  const ev: string[] = [];
  const n = k.cols.c.length;
  let state: FlowState = "NEUTRAL";
  if (s.volumeRatio20 != null) {
    ev.push(`거래량 20봉 평균 대비 ${Math.round(s.volumeRatio20 * 100)}%`);
    const up = n >= 2 && k.cols.c[n - 1]! >= k.cols.c[n - 2]!;
    if (s.volumeRatio20 >= 1.5) state = up ? "INFLOW" : "OUTFLOW";
  } else ev.push("거래량 비교 불가 (데이터 부족)");
  if (s.avgTradingValue20 != null) ev.push(`최근 20일 평균 거래대금 ${Math.round(s.avgTradingValue20 / 1e8).toLocaleString("ko-KR")}억원`);
  return { state, evidence: ev };
}

const FLOW_TEXT: Record<FlowState, string> = {
  INFLOW: "상승 봉에 거래가 실린 상태입니다",
  NEUTRAL: "수급 특이 신호는 없습니다",
  OUTFLOW: "하락 봉에 거래가 실린 상태입니다",
};

/* ───────────── 종합 (§1.1 3요소) ───────────── */

export type InterpretInput = {
  k: Computed;
  snapshot: IndicatorSnapshot;
  annotations: Annotation[];
  higherTrend: TrendState;
  higherLabel: string;
  regimeText: string;
};

export function interpret(input: InterpretInput): Interpretation {
  const { k, snapshot: s, annotations, higherTrend, higherLabel } = input;
  const trend = judgeTrend(k);
  const momentum = judgeMomentum(s);
  const volatility = judgeVolatility(k, s);
  const flow = judgeFlow(k, s);

  const conflict = isConflict(trend.state, higherTrend);
  const timeframeConflict = {
    conflict,
    text: conflict
      ? `⚠ 주 차트는 ${label(trend.state)} 신호이나 ${higherLabel}은 ${label(higherTrend)} 유지 중 — 신호 신뢰도 하향`
      : null,
  };

  const support = annotations.filter((a) => a.kind === "SUPPORT")[0];
  const resistance = annotations.filter((a) => a.kind === "RESISTANCE")[0];
  const ma20 = s.ma["ma20"] ?? null;
  const ma60 = s.ma["ma60"] ?? null;

  /* ① 현재 상태 서술 — 지표값을 그대로 옮긴다 */
  const stateParts: string[] = [`종가 ${won(s.close)}`];
  if (s.rsi14 != null) stateParts.push(`RSI(14) ${s.rsi14.toFixed(1)}${s.rsi14 <= 30 ? "로 과매도 구간" : s.rsi14 >= 70 ? "로 과매수 구간" : ""}`);
  if (ma20 != null) stateParts.push(`20일 이평 ${s.close >= ma20 ? "위" : "아래"} ${f1(Math.abs((s.close - ma20) / ma20) * 100)}%`);
  if (ma60 != null) stateParts.push(`60일 이평 ${s.close >= ma60 ? "위" : "아래"}`);
  if (s.bollinger.pctB != null) stateParts.push(`볼린저 %B ${(s.bollinger.pctB * 100).toFixed(0)}`);
  const stateText = stateParts.join(", ") + ".";

  /* ② 조건부 시나리오 — 반드시 "~할 경우" 형태 */
  const scenarios: string[] = [];
  if (resistance && resistance.kind === "RESISTANCE") {
    scenarios.push(`이 상태에서 저항 ${won(resistance.price)}(${resistance.touches}회 터치)을 거래량 동반으로 상향 돌파할 경우, 직전 고점 구간까지 상단이 열립니다.`);
  } else if (ma20 != null && s.close < ma20) {
    scenarios.push(`이 상태에서 20일 이평 ${won(ma20)}을 상향 돌파할 경우, 단기 평균선 복귀로 해석됩니다.`);
  }
  if (support && support.kind === "SUPPORT") {
    scenarios.push(`반대로 지지 ${won(support.price)}에서 반등이 나오지 않을 경우, 다음 수평 지지대까지 하단이 열립니다.`);
  }
  if (volatility.state === "SQUEEZE") {
    scenarios.push("밴드폭 수축이 해소되며 밴드 밖으로 종가가 형성될 경우, 그 방향으로 변동성이 확대되는 경향이 있습니다. 방향 자체는 이 지표로 예측되지 않습니다.");
  }
  if (scenarios.length === 0) scenarios.push("현재 지표 조합에서는 조건부로 서술할 만한 분기점이 식별되지 않습니다.");

  /* ③ 무효화 조건 — 해석이 깨지는 가격 */
  const invalidationPrice =
    support && support.kind === "SUPPORT" ? support.price
      : ma60 ?? ma20 ?? (s.atr14 != null ? s.close - s.atr14 * 1.5 : s.close * 0.95);
  const invalidation =
    `직전 저점 ${won(invalidationPrice)} 이탈 시 이 해석은 무효입니다.` +
    (conflict ? " 상위 시간프레임 추세와 상충하므로 신뢰도를 낮춰 읽으십시오." : "");

  return {
    trend: { state: trend.state, text: TREND_TEXT[trend.state], evidence: trend.evidence },
    momentum: { state: momentum.state, text: MOMENTUM_TEXT[momentum.state], evidence: momentum.evidence },
    volatility: { state: volatility.state, text: VOL_TEXT[volatility.state], evidence: volatility.evidence },
    flow: { state: flow.state, text: FLOW_TEXT[flow.state], evidence: flow.evidence },
    timeframeConflict,
    composite: { state: stateText, scenarios, invalidation },
  };
}

function isConflict(primary: TrendState, higher: TrendState): boolean {
  return (primary === "UP" && higher === "DOWN") || (primary === "DOWN" && higher === "UP");
}

const label = (s: TrendState): string => (s === "UP" ? "상승" : s === "DOWN" ? "하락" : "횡보");
export { label as trendLabel };

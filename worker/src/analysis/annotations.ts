/**
 * F4 차트 주석 자동 산출. Cron 사전 계산 대상(§2.2-1) — 결과는 analysis_cache.payload 에 포함된다.
 * 각 주석에는 한 줄 해석 라벨(note)을 붙인다.
 */

import type { Annotation, MarketEvent } from "@app/shared";
import { clusterLevels, fibonacci, linreg, pivotHighs, pivotLows } from "../indicators/core.js";
import type { Computed } from "./series.js";
import { kstDate, fromKstDate } from "../lib/time.js";

const won = (n: number): string => Math.round(n).toLocaleString("ko-KR");
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export type AnnotationOpts = {
  /** 피벗 탐지 좌우 폭. 봉이 촘촘할수록 크게 잡는다. */
  pivotSpan?: number;
  /** 수평 레벨 묶음 허용 오차(비율) */
  tolerance?: number;
  maxLevels?: number;
  events?: MarketEvent[];
  longHistory: boolean;
};

export function buildAnnotations(k: Computed, opts: AnnotationOpts): Annotation[] {
  const { t, h, l, c, v } = k.cols;
  const n = c.length;
  if (n < 20) return [];
  const span = opts.pivotSpan ?? (n > 400 ? 5 : 3);
  const tol = opts.tolerance ?? 0.012;
  const maxLevels = opts.maxLevels ?? 3;
  const out: Annotation[] = [];
  const last = c[n - 1]!;

  /* 지지선 / 저항선 — pivot 클러스터링, 최소 2회 터치 */
  const lows = pivotLows(l, span);
  const highs = pivotHighs(h, span);

  for (const lv of clusterLevels(lows, tol, 2).filter((x) => x.price < last * 1.002).slice(0, maxLevels)) {
    out.push({
      kind: "SUPPORT", price: lv.price, touches: lv.touches,
      label: `지지 ${won(lv.price)} (${lv.touches}회 터치)`,
      note: `현재가 대비 ${pct((last - lv.price) / last)} 아래. 이탈 시 하단 근거 소멸`,
    });
  }
  for (const lv of clusterLevels(highs, tol, 2).filter((x) => x.price > last * 0.998).slice(0, maxLevels)) {
    out.push({
      kind: "RESISTANCE", price: lv.price, touches: lv.touches,
      label: `저항 ${won(lv.price)} (${lv.touches}회 터치)`,
      note: `현재가 대비 ${pct((lv.price - last) / last)} 위. 돌파 전까지 상단 제약`,
    });
  }

  /* 추세선 — 최근 스윙 저점/고점 2점 이상을 선형회귀로 보정 */
  const trendPivots = (lows.length >= highs.length ? lows : highs).slice(-5);
  if (trendPivots.length >= 2) {
    const fit = linreg(trendPivots.map((p) => ({ x: p.index, y: p.price })));
    const x1 = trendPivots[0]!.index;
    const x2 = n - 1;
    const y1 = fit.intercept + fit.slope * x1;
    const y2 = fit.intercept + fit.slope * x2;
    const dir = fit.slope > 0 ? "상승" : fit.slope < 0 ? "하락" : "수평";
    out.push({
      kind: "TRENDLINE",
      p1: { t: t[x1]!, price: y1 }, p2: { t: t[x2]!, price: y2 },
      slopePerBar: fit.slope,
      label: `${dir} 추세선`,
      note: `${trendPivots.length}개 스윙점 회귀. 봉당 ${fit.slope >= 0 ? "+" : ""}${won(fit.slope)}원 기울기`,
    });

    /* 추세채널 — 추세선 ± 잔차 표준편차 */
    let acc = 0;
    let cnt = 0;
    for (let i = x1; i < n; i++) {
      const d = c[i]! - (fit.intercept + fit.slope * i);
      acc += d * d; cnt++;
    }
    const sd = cnt > 0 ? Math.sqrt(acc / cnt) : 0;
    if (sd > 0) {
      const pos = (last - (fit.intercept + fit.slope * (n - 1))) / sd;
      out.push({
        kind: "CHANNEL",
        p1: { t: t[x1]!, price: y1 }, p2: { t: t[x2]!, price: y2 },
        width: sd,
        label: `추세채널 ±${won(sd)}`,
        note: `현재가는 채널 중심선 대비 ${pos >= 0 ? "+" : ""}${pos.toFixed(1)}σ 위치`,
      });
    }
  }

  /* 피보나치 되돌림 — 직전 주요 스윙 고점–저점 */
  const swing = lastSwing(h, l, span);
  if (swing) {
    const levels = fibonacci(swing.high.price, swing.low.price);
    const nearest = levels.reduce((a, b) => (Math.abs(b.price - last) < Math.abs(a.price - last) ? b : a));
    out.push({
      kind: "FIBONACCI",
      swingHigh: { t: t[swing.high.index]!, price: swing.high.price },
      swingLow: { t: t[swing.low.index]!, price: swing.low.price },
      levels,
      label: `피보나치 ${won(swing.low.price)}–${won(swing.high.price)}`,
      note: `현재가는 ${(nearest.ratio * 100).toFixed(1)}% 레벨(${won(nearest.price)}) 부근`,
    });
  }

  /* 골든·데드크로스 */
  for (const [fast, slow] of [[5, 20], [20, 60], [60, 120]] as const) {
    if (!opts.longHistory && slow >= 120) continue;
    const f = k.ma[fast]!;
    const s = k.ma[slow]!;
    for (let i = Math.max(1, n - 250); i < n; i++) {
      const f0 = f[i - 1], f1 = f[i], s0 = s[i - 1], s1 = s[i];
      if (f0 == null || f1 == null || s0 == null || s1 == null) continue;
      if (f0 <= s0 && f1 > s1) out.push(crossAnn(t[i]!, c[i]!, "GOLDEN", fast, slow));
      else if (f0 >= s0 && f1 < s1) out.push(crossAnn(t[i]!, c[i]!, "DEAD", fast, slow));
    }
  }

  /* 볼린저 스퀴즈 — 밴드폭 하위 20% 구간 */
  const bw = k.bb.bandwidth.map((x, i) => ({ i, v: x })).filter((x): x is { i: number; v: number } => x.v !== null);
  if (bw.length >= 30) {
    const sorted = [...bw].sort((a, b) => a.v - b.v);
    const threshold = sorted[Math.floor(sorted.length * 0.2)]!.v;
    let runStart: number | null = null;
    for (const { i, v } of bw) {
      if (v <= threshold) { if (runStart === null) runStart = i; }
      else if (runStart !== null) { pushSqueeze(out, t, runStart, i - 1); runStart = null; }
    }
    if (runStart !== null) pushSqueeze(out, t, runStart, bw[bw.length - 1]!.i);
  }

  /* 거래량 급증 — 20일 평균 대비 200% 이상 */
  for (let i = Math.max(0, n - 250); i < n; i++) {
    const avg = k.volMa20[i];
    if (avg == null || avg <= 0) continue;
    const ratio = v[i]! / avg;
    if (ratio >= 2) {
      out.push({
        kind: "VOLUME_SPIKE", t: t[i]!, ratio,
        label: `거래량 ${ratio.toFixed(1)}배`,
        note: `20봉 평균 대비 ${Math.round(ratio * 100)}% — 가격 변화 방향과 함께 읽을 것`,
      });
    }
  }

  /* 이벤트 오버레이 */
  for (const e of opts.events ?? []) {
    const ts = fromKstDate(e.date);
    if (ts < t[0]! || ts > t[n - 1]! + 86_400_000) continue;
    out.push({
      kind: "EVENT", t: ts, date: e.date, eventKind: e.kind, memo: e.memo ?? "",
      label: `${e.date} ${e.kind}`,
      note: e.memo ?? "일정 전후 변동성 확대 가능",
    });
  }

  return out;
}

function crossAnn(t: number, price: number, cross: "GOLDEN" | "DEAD", fast: number, slow: number): Annotation {
  return {
    kind: "MA_CROSS", t, price, cross, fast, slow,
    label: `${cross === "GOLDEN" ? "골든" : "데드"}크로스 ${fast}/${slow} · ${kstDate(t)}`,
    note: cross === "GOLDEN"
      ? `${fast}일선이 ${slow}일선을 상향 돌파 — 단기 평균이 중기 평균 위로 올라선 상태`
      : `${fast}일선이 ${slow}일선을 하향 이탈 — 단기 평균이 중기 평균 아래로 내려간 상태`,
  };
}

function pushSqueeze(out: Annotation[], t: number[], a: number, b: number): void {
  if (b - a < 2) return;   // 2봉 이하 구간은 노이즈
  out.push({
    kind: "BB_SQUEEZE", from: t[a]!, to: t[b]!,
    label: `볼린저 스퀴즈 ${b - a + 1}봉`,
    note: "밴드폭 하위 20% — 변동성 수축 구간. 방향은 제시하지 않음",
  });
}

/** 직전 주요 스윙(고점·저점 쌍). 마지막 피벗을 기준으로 가장 가까운 반대 피벗을 짝짓는다. */
export function lastSwing(h: number[], l: number[], span: number):
  { high: { index: number; price: number }; low: { index: number; price: number } } | null {
  const highs = pivotHighs(h, span);
  const lows = pivotLows(l, span);
  if (highs.length === 0 || lows.length === 0) return null;
  const lastHigh = highs[highs.length - 1]!;
  const lastLow = lows[lows.length - 1]!;
  if (lastHigh.index > lastLow.index) {
    const prevLow = [...lows].reverse().find((p) => p.index < lastHigh.index) ?? lastLow;
    return { high: lastHigh, low: prevLow };
  }
  const prevHigh = [...highs].reverse().find((p) => p.index < lastLow.index) ?? lastHigh;
  return { high: prevHigh, low: lastLow };
}

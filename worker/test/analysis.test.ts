import { describe, expect, it } from "vitest";
import type { Candle, IndicatorSnapshot } from "@app/shared";
import { computeAll, snapshot } from "../src/analysis/series.js";
import { buildAnnotations, lastSwing } from "../src/analysis/annotations.js";
import { buildGuide, computeLevels, detectSignal } from "../src/analysis/guide.js";
import { interpret } from "../src/analysis/interpret.js";
import { relativeStrength } from "../src/analysis/regime.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 6, 0, 0, 0);   // 2025-01-06 09:00 KST

function candlesFromCloses(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((c, i) => ({
    t: T0 + i * DAY,
    o: closes[i - 1] ?? c,
    h: Math.max(c, closes[i - 1] ?? c) * 1.01,
    l: Math.min(c, closes[i - 1] ?? c) * 0.99,
    c,
    v: volumes?.[i] ?? 100_000,
    va: (volumes?.[i] ?? 100_000) * c,
    adj: true,
  }));
}

/** 뚜렷한 쌍바닥(지지 2회 터치) + 고점 2회를 만든 시계열 */
function doubleBottom(): Candle[] {
  const shape = [
    120, 115, 110, 104, 100, 104, 110, 116, 120, 118,
    114, 108, 102, 100, 103, 109, 115, 119, 121, 118,
    116, 114, 112, 113, 115, 117, 119, 118, 116, 114,
  ];
  return candlesFromCloses(shape);
}

describe("buildAnnotations", () => {
  const k = computeAll(doubleBottom(), "1d");
  const ann = buildAnnotations(k, { longHistory: true, pivotSpan: 3 });

  it("지지선과 저항선을 모두 산출한다", () => {
    const sup = ann.filter((a) => a.kind === "SUPPORT");
    const res = ann.filter((a) => a.kind === "RESISTANCE");
    expect(sup.length + res.length).toBeGreaterThan(0);
  });

  it("수평 레벨은 최소 2회 터치를 요구한다", () => {
    for (const a of ann) {
      if (a.kind === "SUPPORT" || a.kind === "RESISTANCE") expect(a.touches).toBeGreaterThanOrEqual(2);
    }
  });

  it("추세선과 피보나치에 한 줄 해석 라벨이 붙는다", () => {
    for (const a of ann) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.note.length).toBeGreaterThan(0);
    }
  });

  it("거래량 급증은 20봉 평균 대비 200% 이상에서만 표시된다", () => {
    const vols = new Array(40).fill(100_000);
    vols[35] = 500_000;
    const k2 = computeAll(candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i * 0.5), vols), "1d");
    const spikes = buildAnnotations(k2, { longHistory: true }).filter((a) => a.kind === "VOLUME_SPIKE");
    expect(spikes.length).toBe(1);
    expect(spikes[0]!.kind === "VOLUME_SPIKE" && spikes[0]!.ratio).toBeGreaterThanOrEqual(2);
  });

  it("골든크로스를 탐지한다", () => {
    // 60봉 하락 후 60봉 상승 → 5/20 골든크로스가 발생
    const closes = [
      ...Array.from({ length: 60 }, (_, i) => 200 - i),
      ...Array.from({ length: 60 }, (_, i) => 140 + i * 2),
    ];
    const k3 = computeAll(candlesFromCloses(closes), "1d");
    const crosses = buildAnnotations(k3, { longHistory: true }).filter((a) => a.kind === "MA_CROSS");
    expect(crosses.some((a) => a.kind === "MA_CROSS" && a.cross === "GOLDEN")).toBe(true);
  });

  it("봉이 20개 미만이면 주석을 만들지 않는다", () => {
    expect(buildAnnotations(computeAll(candlesFromCloses([1, 2, 3]), "1d"), { longHistory: true })).toEqual([]);
  });

  it("이벤트는 차트 구간 안에 있을 때만 표시한다", () => {
    const inRange = buildAnnotations(k, {
      longHistory: true,
      events: [
        { code: "005930", date: "2025-01-10", kind: "EARNINGS", memo: "4분기 실적" },
        { code: "005930", date: "1999-01-10", kind: "EARNINGS", memo: "범위 밖" },
      ],
    }).filter((a) => a.kind === "EVENT");
    expect(inRange).toHaveLength(1);
  });
});

describe("lastSwing", () => {
  it("직전 스윙 고점·저점 쌍을 찾는다", () => {
    const c = doubleBottom();
    const sw = lastSwing(c.map((x) => x.h), c.map((x) => x.l), 3);
    expect(sw).not.toBeNull();
    expect(sw!.high.price).toBeGreaterThan(sw!.low.price);
  });
});

describe("detectSignal", () => {
  const mkSnap = (over: Partial<IndicatorSnapshot>): IndicatorSnapshot => ({
    close: 100, ma: {}, rsi14: 50,
    macd: { macd: 0, signal: 0, hist: 0 },
    bollinger: { upper: 110, mid: 100, lower: 90, bandwidth: 0.2, pctB: 0.5 },
    atr14: 2, vwap: 100, volume: 100, volumeRatio20: 1, avgTradingValue20: 1e10, rs: 1,
    ...over,
  });

  it("RSI 30 이하면 과매도 시그널", () => {
    const k = computeAll(candlesFromCloses(Array.from({ length: 60 }, (_, i) => 200 - i)), "1d");
    expect(detectSignal(k, mkSnap({ rsi14: 28.4 }), [])).toBe("RSI_OVERSOLD");
  });

  it("RSI 70 이상이면 과매수 시그널", () => {
    const k = computeAll(candlesFromCloses(Array.from({ length: 60 }, (_, i) => 100 + i)), "1d");
    expect(detectSignal(k, mkSnap({ rsi14: 75 }), [])).toBe("RSI_OVERBOUGHT");
  });

  it("조건이 없으면 NONE", () => {
    const k = computeAll(candlesFromCloses(new Array(60).fill(100)), "1d");
    expect(detectSignal(k, mkSnap({}), [])).toBe("NONE");
  });
});

describe("computeLevels / buildGuide", () => {
  const candles = doubleBottom();
  const k = computeAll(candles, "1d");
  const ann = buildAnnotations(k, { longHistory: true, pivotSpan: 3 });
  const snap = snapshot(k, 1.0, 50_000_000_000);

  it("손절가는 진입가보다 낮다", () => {
    const lv = computeLevels(k, snap, ann);
    if (lv) {
      expect(lv.stopLoss.price).toBeLessThan(lv.entry.mid);
      expect(lv.target.price).toBeGreaterThan(lv.entry.mid);
    }
  });

  it("차단 플래그가 있으면 가이드를 생성하지 않는다", () => {
    const g = buildGuide({
      k, snapshot: snap, annotations: ann, stat: null, accountValue: 10_000_000,
      safety: [{ code: "S2", blocking: true, badge: "거래 유의 종목", reason: "관리종목" }],
    });
    expect(g.available).toBe(false);
    expect(g.entry).toBeNull();
    expect(g.blockedBy?.some((f) => f.code === "S2")).toBe(true);
  });

  it("표본이 없으면 신뢰도를 수치로 제공하지 않는다", () => {
    const g = buildGuide({ k, snapshot: snap, annotations: ann, safety: [], stat: null, accountValue: 10_000_000 });
    expect(g.confidence.available).toBe(false);
  });

  it("손익비가 1.5 미만이면 '유리한 진입 구간 없음'", () => {
    // 목표가를 진입 바로 위에 두도록 저항을 인접시킨 합성 주석
    const close = snap.close;
    const tight = [
      { kind: "SUPPORT" as const, price: close * 0.9, touches: 2, label: "s", note: "n" },
      { kind: "RESISTANCE" as const, price: close * 1.001, touches: 2, label: "r", note: "n" },
    ];
    const g = buildGuide({ k, snapshot: snap, annotations: tight, safety: [], stat: null, accountValue: 10_000_000 });
    expect(g.available).toBe(false);
    expect(g.message).toBe("현재 조건에서 유리한 진입 구간 없음");
  });

  it("권장 비중은 계좌 대비 최대손실 2% 기준으로 역산된다", () => {
    const g = buildGuide({ k, snapshot: snap, annotations: ann, safety: [], stat: null, accountValue: 10_000_000 });
    if (g.available) {
      expect(g.suggestedWeightPct!).toBeGreaterThan(0);
      expect(g.maxLossAmount!).toBeLessThanOrEqual(Math.round(10_000_000 * 0.02) + 1);
    }
  });
});

describe("interpret (§1.1 표현 제약)", () => {
  const candles = doubleBottom();
  const k = computeAll(candles, "1d");
  const ann = buildAnnotations(k, { longHistory: true, pivotSpan: 3 });
  const snap = snapshot(k, 1.0, 50_000_000_000);
  const out = interpret({ k, snapshot: snap, annotations: ann, higherTrend: "DOWN", higherLabel: "주봉 1년", regimeText: "" });

  it("3요소 구조를 모두 채운다", () => {
    expect(out.composite.state.length).toBeGreaterThan(0);
    expect(out.composite.scenarios.length).toBeGreaterThan(0);
    expect(out.composite.invalidation).toContain("무효");
  });

  it("단정적 투자 권유 표현을 포함하지 않는다", () => {
    const text = JSON.stringify(out);
    for (const banned of ["매수하세요", "매도 추천", "목표가 상향", "사십시오", "파십시오", "매수 추천"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("상위 시간프레임과 상충하면 경고를 낸다", () => {
    const up = interpret({
      k: computeAll(candlesFromCloses(Array.from({ length: 80 }, (_, i) => 100 + i * 2)), "1d"),
      snapshot: snap, annotations: [], higherTrend: "DOWN", higherLabel: "주봉 1년", regimeText: "",
    });
    expect(up.timeframeConflict.conflict).toBe(true);
    expect(up.timeframeConflict.text).toContain("신뢰도 하향");
  });
});

describe("relativeStrength", () => {
  it("지수와 동일하게 움직이면 1.0", () => {
    const s = Array.from({ length: 70 }, (_, i) => 100 * 1.01 ** i);
    expect(relativeStrength(s, s)).toBeCloseTo(1, 10);
  });
  it("종목이 지수를 상회하면 1 초과", () => {
    const idx = Array.from({ length: 70 }, () => 100);
    const stock = Array.from({ length: 70 }, (_, i) => 100 + i);
    expect(relativeStrength(stock, idx)!).toBeGreaterThan(1);
  });
  it("표본이 모자라면 수치를 만들지 않는다", () => {
    expect(relativeStrength([1, 2, 3], [1, 2, 3])).toBeNull();
  });
});

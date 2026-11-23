import { describe, expect, it } from "vitest";
import {
  atr, bollinger, clusterLevels, ema, fibonacci, linreg, macd,
  pivotHighs, pivotLows, rma, rsi, sma, stdev, vwap,
} from "../src/indicators/core.js";

/** 지표 계산 함수 단위 테스트 — 알려진 값으로 검증(§8.2) */

describe("sma", () => {
  it("워밍업 구간은 null, 이후 단순평균", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("기간이 데이터보다 길면 전부 null", () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe("ema", () => {
  it("첫 period 개 SMA 를 시드로 사용한다", () => {
    // seed = (1+2+3)/3 = 2, k = 0.5 → 4*0.5+2*0.5 = 3, 5*0.5+3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("상수 입력은 상수를 유지한다", () => {
    expect(ema([7, 7, 7, 7, 7], 3)).toEqual([null, null, 7, 7, 7]);
  });
});

describe("rma (Wilder)", () => {
  it("(prev*(n-1)+x)/n 로 평활한다", () => {
    // seed = (1+1)/2 = 1 → (1*1+3)/2 = 2
    expect(rma([1, 1, 3], 2)).toEqual([null, 1, 2]);
  });
});

describe("stdev", () => {
  it("모표준편차(population)로 계산한다", () => {
    // [2,4,4,4,5,5,7,9] → 평균 5, 분산 4, 표준편차 2
    const out = stdev([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(out[7]).toBeCloseTo(2, 10);
  });
});

describe("rsi (Wilder, 손계산 대조)", () => {
  it("closes=[10,11,12,11,12], period=3", () => {
    const out = rsi([10, 11, 12, 11, 12], 3);
    expect(out[0]).toBeNull();
    expect(out[2]).toBeNull();
    // avgGain=0.6667 avgLoss=0.3333 → RS=2 → 66.667
    expect(out[3]!).toBeCloseTo(66.6667, 3);
    // avgGain=0.7778 avgLoss=0.2222 → RS=3.5 → 77.778
    expect(out[4]!).toBeCloseTo(77.7778, 3);
  });
  it("단조 상승은 100, 단조 하락은 0", () => {
    const up = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    const down = rsi([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14);
    expect(up[15]!).toBeCloseTo(100, 6);
    expect(down[15]!).toBeCloseTo(0, 6);
  });
  it("변동이 없으면 50", () => {
    expect(rsi(new Array(20).fill(100), 14)[15]).toBe(50);
  });
});

describe("macd", () => {
  it("상수 입력이면 macd·시그널·히스토그램이 0", () => {
    const out = macd(new Array(60).fill(50));
    expect(out.macd[59]!).toBeCloseTo(0, 10);
    expect(out.signal[59]!).toBeCloseTo(0, 10);
    expect(out.hist[59]!).toBeCloseTo(0, 10);
  });
  it("상승 추세에서는 macd 가 양수", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(macd(closes).macd[79]!).toBeGreaterThan(0);
  });
  it("시그널은 macd 유효 구간에서만 산출된다", () => {
    const out = macd(Array.from({ length: 40 }, (_, i) => 100 + i));
    expect(out.signal[24]).toBeNull();           // macd 자체가 25번째(index 25)부터
    expect(out.signal[33]).not.toBeNull();
  });
});

describe("bollinger", () => {
  it("상수 입력이면 밴드폭 0", () => {
    const out = bollinger(new Array(30).fill(100), 20, 2);
    expect(out.upper[29]).toBe(100);
    expect(out.lower[29]).toBe(100);
    expect(out.bandwidth[29]).toBe(0);
  });
  it("%B 는 하단 0, 상단 1", () => {
    const closes = [2, 4, 4, 4, 5, 5, 7, 9];
    const out = bollinger(closes, 8, 2);
    // 평균 5, sd 2 → upper 9, lower 1, 종가 9 → %B = 1
    expect(out.upper[7]).toBeCloseTo(9, 10);
    expect(out.lower[7]).toBeCloseTo(1, 10);
    expect(out.pctB[7]).toBeCloseTo(1, 10);
  });
});

describe("atr", () => {
  it("TR 을 Wilder 평활한다", () => {
    const out = atr([10, 11, 12], [8, 9, 10], [9, 10, 11], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(2, 10);
    expect(out[2]).toBeCloseTo(2, 10);
  });
  it("갭 상승 시 TR 이 고저폭보다 크다", () => {
    const out = atr([20, 30], [19, 29], [19.5, 29.5], 2);
    // TR[1] = max(1, |30-19.5|=10.5, |29-19.5|=9.5) = 10.5 → seed (1+10.5)/2
    expect(out[1]).toBeCloseTo(5.75, 10);
  });
});

describe("vwap", () => {
  it("세션이 바뀌면 누적을 리셋한다", () => {
    const h = [10, 10, 20, 20];
    const l = [10, 10, 20, 20];
    const c = [10, 10, 20, 20];
    const v = [100, 100, 100, 100];
    const out = vwap(h, l, c, v, (i) => (i < 2 ? "d1" : "d2"));
    expect(out[1]).toBeCloseTo(10, 10);
    expect(out[2]).toBeCloseTo(20, 10);   // 리셋되어 이전 세션 10원이 섞이지 않는다
  });
  it("거래량 가중이 적용된다", () => {
    const out = vwap([10, 20], [10, 20], [10, 20], [1, 3], () => "s");
    expect(out[1]).toBeCloseTo((10 * 1 + 20 * 3) / 4, 10);
  });
});

describe("linreg", () => {
  it("완전한 직선의 기울기를 복원한다", () => {
    const fit = linreg([0, 1, 2, 3].map((x) => ({ x, y: 3 * x + 5 })));
    expect(fit.slope).toBeCloseTo(3, 10);
    expect(fit.intercept).toBeCloseTo(5, 10);
  });
});

describe("pivot / clusterLevels", () => {
  // span=2 이므로 양끝 2개 봉은 피벗 후보에서 제외된다.
  const low = [12, 10, 8, 10, 12, 12, 10, 8.1, 10, 12];
  it("스윙 저점을 찾는다", () => {
    expect(pivotLows(low, 2).map((p) => p.index)).toEqual([2, 7]);
  });
  it("스윙 고점을 찾는다", () => {
    const high = [1, 2, 5, 2, 1, 2, 6, 2, 1];
    expect(pivotHighs(high, 2).map((p) => p.index)).toEqual([2, 6]);
  });
  it("허용 오차 안의 피벗을 하나의 레벨로 묶는다", () => {
    const levels = clusterLevels(pivotLows(low, 2), 0.02, 2);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.touches).toBe(2);
    expect(levels[0]!.price).toBeCloseTo(8.05, 6);
  });
  it("터치가 1회뿐이면 레벨로 인정하지 않는다", () => {
    expect(clusterLevels([{ index: 1, price: 100 }], 0.01, 2)).toEqual([]);
  });
});

describe("fibonacci", () => {
  it("고점 100 · 저점 0 의 되돌림 레벨", () => {
    const lv = fibonacci(100, 0);
    expect(lv.map((x) => x.price)).toEqual([100, 76.4, 61.8, 50, 38.2, 0].map((v) => expect.closeTo(v, 6)) as never);
  });
});

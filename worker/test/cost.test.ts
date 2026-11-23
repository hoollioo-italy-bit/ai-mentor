import { describe, expect, it } from "vitest";
import { COST, computeCost, executionCost, expectedReturn, slippageRate } from "../src/analysis/cost.js";
import { maxDrawdown } from "../src/routes/performance.js";

/** 비용 계산 함수 단위 테스트 — 알려진 값으로 검증(§8.2) */

describe("slippageRate", () => {
  it("거래대금 구간별 경계값", () => {
    expect(slippageRate(100_000_000_000)).toBe(0.0005);
    expect(slippageRate(99_999_999_999)).toBe(0.0010);
    expect(slippageRate(10_000_000_000)).toBe(0.0010);
    expect(slippageRate(9_999_999_999)).toBe(0.0030);
    expect(slippageRate(0)).toBe(0.0030);
  });
});

describe("computeCost", () => {
  it("코스피 왕복 비용을 항목별로 분해한다", () => {
    // 매수 10,000원 × 100주 = 1,000,000 / 매도 11,000원 × 100주 = 1,100,000
    // 슬리피지 구간: 2,000억 → 0.05%
    const c = computeCost({
      market: "KOSPI", buyPrice: 10_000, sellPrice: 11_000, qty: 100,
      avgTradingValue: 200_000_000_000,
    });
    expect(c.buyFee).toBe(150);        // 1,000,000 × 0.015%
    expect(c.sellFee).toBe(165);       // 1,100,000 × 0.015%
    expect(c.sellTax).toBe(1650);      // 1,100,000 × 0.15%
    expect(c.slippage).toBe(1050);     // 2,100,000 × 0.05%
    expect(c.total).toBe(3015);
    expect(c.totalRate).toBeCloseTo(3015 / 1_000_000, 10);
  });

  it("ETF 는 증권거래세가 0", () => {
    const c = computeCost({ market: "ETF", buyPrice: 10_000, sellPrice: 11_000, qty: 100, avgTradingValue: 200_000_000_000 });
    expect(c.sellTax).toBe(0);
    expect(COST.sellTaxRateByMarket.ETF).toBe(0);
  });

  it("유동성이 낮으면 슬리피지가 6배로 뛴다", () => {
    const base = { market: "KOSDAQ" as const, buyPrice: 10_000, sellPrice: 10_000, qty: 100 };
    const big = computeCost({ ...base, avgTradingValue: 200_000_000_000 });
    const small = computeCost({ ...base, avgTradingValue: 1_000_000_000 });
    expect(small.slippage).toBe(big.slippage * 6);
  });
});

describe("expectedReturn", () => {
  it("비용 차감 후 순수익률을 산출한다", () => {
    const r = expectedReturn({
      market: "KOSPI", buyPrice: 10_000, sellPrice: 11_000, qty: 100,
      avgTradingValue: 200_000_000_000,
    });
    expect(r.grossProfit).toBe(100_000);
    expect(r.netProfit).toBe(100_000 - 3015);
    expect(r.netReturnRate).toBeCloseTo(96_985 / 1_000_000, 10);
    expect(r.grossReturnRate).toBeCloseTo(0.1, 10);
    expect(r.costWarning).toBe(false);
  });

  it("비용이 기대수익의 30% 를 넘으면 경고", () => {
    // 기대수익 1,000원 대비 왕복 비용이 훨씬 크다
    const r = expectedReturn({
      market: "KOSPI", buyPrice: 10_000, sellPrice: 10_010, qty: 100,
      avgTradingValue: 1_000_000_000,
    });
    expect(r.grossProfit).toBe(1000);
    expect(r.costWarning).toBe(true);
    expect(r.costRatioOfGross!).toBeGreaterThan(0.3);
  });

  it("손실 구간에서는 비용비율을 산출하지 않는다", () => {
    const r = expectedReturn({ market: "KOSPI", buyPrice: 10_000, sellPrice: 9_000, qty: 10, avgTradingValue: 1e11 });
    expect(r.costRatioOfGross).toBeNull();
    expect(r.costWarning).toBe(false);
    expect(r.netProfit).toBeLessThan(r.grossProfit);
  });
});

describe("executionCost", () => {
  it("매수에는 거래세가 붙지 않는다", () => {
    const c = executionCost("BUY", "KOSPI", 10_000, 100, 200_000_000_000);
    expect(c.tax).toBe(0);
    expect(c.fee).toBe(150);
    expect(c.slippage).toBe(500);
  });
  it("매도에는 수수료·거래세·슬리피지가 모두 붙는다", () => {
    const c = executionCost("SELL", "KOSDAQ", 10_000, 100, 200_000_000_000);
    expect(c.fee).toBe(150);
    expect(c.tax).toBe(1500);
    expect(c.slippage).toBe(500);
  });
});

describe("maxDrawdown", () => {
  it("최대 낙폭을 음수로 돌려준다", () => {
    expect(maxDrawdown([100, 120, 90, 110])).toBeCloseTo(-0.25, 10);
  });
  it("단조 증가면 0", () => {
    expect(maxDrawdown([100, 110, 120])).toBe(0);
  });
  it("빈 배열은 0", () => {
    expect(maxDrawdown([])).toBe(0);
  });
});

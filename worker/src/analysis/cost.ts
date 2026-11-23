/**
 * F7 매매비용 모델. 단위 테스트 필수(§8.2).
 *
 * ⚠ 세율 검증 상태 — §11 은 "제도 관련 수치는 구현 시점 기준으로 검증"을 요구하나,
 *   본 실행 환경은 외부 네트워크가 차단되어 1차 출처(국세청·금융투자협회·거래소) 확인이
 *   불가능했다. 아래 값은 명세 §7 이 제시한 수치(0.0015)와 2025년 시행 기준 세율 체계를
 *   반영한 것이며, **운영 반영 전 반드시 재확인**하십시오.
 *
 *   근거(재확인 대상):
 *     · 증권거래세법 + 농어촌특별세법 — 유가증권(코스피) 상장주식 양도:
 *       증권거래세 0% + 농어촌특별세 0.15% = 합계 0.15%
 *     · 코스닥 상장주식 양도: 증권거래세 0.15%
 *     · 국내 주식형 ETF·ETN 양도: 증권거래세 비과세
 *     · 매매수수료는 증권사별 상이 — 0.015%는 대표적인 비대면 계좌 수준의 가정값
 *
 *   재확인 절차: docs/provider-migration.md 의 "세율 검증" 절 참조.
 */

import type { CostBreakdown, ExpectedReturn, Market } from "@app/shared";

export const TAX_RATE_VERIFIED_AT: string | null = null;   // 검증 완료 시 "YYYY-MM-DD" 기입

export const COST = {
  buyFeeRate: 0.00015,
  sellFeeRate: 0.00015,
  /** 시장별 상이 — 최신 세율 확인 필수 */
  sellTaxRateByMarket: {
    KOSPI: 0.0015,
    KOSDAQ: 0.0015,
    ETF: 0,
    ETN: 0,
  } as Record<Market, number>,
} as const;

/** 일평균 거래대금 기준 슬리피지율 — 명세 §7 원문 */
export function slippageRate(avgTradingValue: number): number {
  if (avgTradingValue >= 100_000_000_000) return 0.0005;
  if (avgTradingValue >= 10_000_000_000) return 0.0010;
  return 0.0030;
}

export type CostInput = {
  market: Market;
  buyPrice: number;
  sellPrice: number;
  qty: number;
  avgTradingValue: number;
};

/** 왕복(매수+매도) 비용을 항목별로 분해한다. 모두 원 단위 반올림. */
export function computeCost(i: CostInput): CostBreakdown {
  const buyAmount = i.buyPrice * i.qty;
  const sellAmount = i.sellPrice * i.qty;
  const slipRate = slippageRate(i.avgTradingValue);
  const buyFee = Math.round(buyAmount * COST.buyFeeRate);
  const sellFee = Math.round(sellAmount * COST.sellFeeRate);
  const sellTax = Math.round(sellAmount * (COST.sellTaxRateByMarket[i.market] ?? 0));
  // 슬리피지는 진입·청산 양쪽에서 발생한다.
  const slippage = Math.round((buyAmount + sellAmount) * slipRate);
  const total = buyFee + sellFee + sellTax + slippage;
  return { buyFee, sellFee, sellTax, slippage, total, totalRate: buyAmount > 0 ? total / buyAmount : 0 };
}

/** 비용 차감 후 순수익률을 **주 표시**로 산출한다(§F7). */
export function expectedReturn(i: CostInput): ExpectedReturn {
  const buyAmount = i.buyPrice * i.qty;
  const grossProfit = (i.sellPrice - i.buyPrice) * i.qty;
  const cost = computeCost(i);
  const netProfit = grossProfit - cost.total;
  const costRatioOfGross = grossProfit > 0 ? cost.total / grossProfit : null;
  return {
    grossProfit,
    cost,
    netProfit,
    netReturnRate: buyAmount > 0 ? netProfit / buyAmount : 0,
    grossReturnRate: buyAmount > 0 ? grossProfit / buyAmount : 0,
    // 비용이 기대수익의 30%를 초과하면 경고
    costWarning: costRatioOfGross !== null && costRatioOfGross > 0.3,
    costRatioOfGross,
  };
}

/** 단건 체결(매수 또는 매도)의 비용 — 모의투자 실행(F8)에 사용. */
export function executionCost(
  side: "BUY" | "SELL", market: Market, price: number, qty: number, avgTradingValue: number,
): { fee: number; tax: number; slippage: number } {
  const amount = price * qty;
  const slip = Math.round(amount * slippageRate(avgTradingValue));
  if (side === "BUY") return { fee: Math.round(amount * COST.buyFeeRate), tax: 0, slippage: slip };
  return {
    fee: Math.round(amount * COST.sellFeeRate),
    tax: Math.round(amount * (COST.sellTaxRateByMarket[market] ?? 0)),
    slippage: slip,
  };
}

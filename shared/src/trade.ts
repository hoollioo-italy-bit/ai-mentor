/* F7 · F8 모의투자 도메인 타입 */

export type Side = "BUY" | "SELL";

export type Portfolio = {
  portfolioId: string;
  userId: string;
  name: string;
  initialCash: number;
  cash: number;
  createdAt: number;
};

export type Trade = {
  tradeId: string;
  portfolioId: string;
  code: string;
  side: Side;
  price: number;
  qty: number;
  tradedAt: number;
  fee: number;
  tax: number;
  slippage: number;
  signalId: string | null;
};

export type Position = {
  portfolioId: string;
  code: string;
  name?: string;
  qty: number;
  avgPrice: number;
  stopLoss: number | null;
  target: number | null;
};

export type CostBreakdown = {
  buyFee: number;
  sellFee: number;
  sellTax: number;
  slippage: number;
  total: number;
  /** 총비용 ÷ 총매수금액 */
  totalRate: number;
};

export type ExpectedReturn = {
  grossProfit: number;
  cost: CostBreakdown;
  /** 비용 차감 후 순손익(원) — 주 표시 */
  netProfit: number;
  /** 비용 차감 후 순수익률 — 주 표시 */
  netReturnRate: number;
  grossReturnRate: number;
  /** 비용이 기대수익의 30%를 초과 */
  costWarning: boolean;
  costRatioOfGross: number | null;
};

export type Performance = {
  portfolioId: string;
  totalValue: number;
  cash: number;
  marketValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  cumulativeReturn: number;
  mdd: number;
  winRate: number | null;
  avgWinLossRatio: number | null;
  tradeCount: number;
  closedCount: number;
  /** 정규화(시작=100) 시계열 */
  benchmark: {
    dates: number[];
    portfolio: number[];
    index: number[];
    indexName: string;
    buyAndHold: number[];
    buyAndHoldName: string;
  };
  /** "Buy&Hold 대비 -2.4%p — 매매가 수익을 훼손함" */
  verdict: string;
};

export type Watch = { userId: string; code: string; name?: string; addedAt: number; lastSeen: number };

export type AlertKind = "STOP_LOSS" | "TARGET";
export type Alert = { alertId: string; userId: string; code: string; kind: AlertKind; threshold: number; firedAt: number | null };

export type MarketEventKind = "EARNINGS" | "EX_DIVIDEND" | "SPLIT" | "ETC";
export type MarketEvent = { code: string; date: string; kind: MarketEventKind; memo: string | null };

export const EVENT_LABEL: Record<MarketEventKind, string> = {
  EARNINGS: "실적발표",
  EX_DIVIDEND: "배당락",
  SPLIT: "액면분할",
  ETC: "기타",
};

import type {
  AnalysisPayload, ApiResponse, Candle, Horizon, Interval, MarketEvent,
  MarketEventKind, Performance, SignalStat,
} from "@app/shared";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  let body: ApiResponse<T>;
  try { body = (await res.json()) as ApiResponse<T>; }
  catch { throw new ApiError("PARSE", `응답을 해석할 수 없습니다 (HTTP ${res.status}).`, res.status); }
  if (!body.ok) throw new ApiError(body.error.code, body.error.message, res.status, body.error.detail);
  return body.data;
}

export type SearchItem = {
  code: string; name: string; market: string; status: string[] | null;
  avgTradingValue: number | null;
  price: number | null; change: number | null; changeRate: number | null; asOf: number | null;
};

export const api = {
  search: (q: string, market?: string | null) =>
    call<{ items: SearchItem[]; masterUpdatedAt: number }>(
      `/api/symbols/search?q=${encodeURIComponent(q)}${market ? `&market=${market}` : ""}`),

  symbol: (code: string) =>
    call<{ symbol: SearchItem; quote: { price: number; change: number; changeRate: number; t: number } | null }>(
      `/api/symbols/${code}`),

  candles: (code: string, interval: Interval, from?: number, to?: number) =>
    call<{ code: string; interval: Interval; count: number; source: string; candles: Candle[] }>(
      `/api/candles/${code}?interval=${interval}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),

  analysis: (code: string, horizon: Horizon, accountValue?: number, refresh = false) =>
    call<AnalysisPayload & { cached: boolean }>(
      `/api/analysis/${code}?horizon=${horizon}${accountValue ? `&accountValue=${accountValue}` : ""}${refresh ? "&refresh=1" : ""}`),

  regime: () => call<{
    kospi: { trend: string; close: number; changeRate: number };
    kosdaq: { trend: string; close: number; changeRate: number };
    asOf: number;
  }>("/api/market/regime"),

  signalStats: (days = 20, type?: string) =>
    call<{ horizonDays: number; stats: SignalStat[]; labels: Record<string, string>; verification: { scored: number; hitRate: number | null }; pendingScoring: number }>(
      `/api/signals/stats?days=${days}${type ? `&type=${type}` : ""}`),

  saveSignal: (code: string, horizon: Horizon) =>
    call<{ signalId: string | null; signalType: string }>("/api/signals", {
      method: "POST", body: JSON.stringify({ code, horizon }),
    }),

  portfolios: () => call<{ items: { portfolio_id: string; name: string; initial_cash: number; cash: number }[] }>("/api/portfolios"),
  createPortfolio: (name: string, initialCash: number) =>
    call<{ portfolioId: string }>("/api/portfolios", { method: "POST", body: JSON.stringify({ name, initialCash }) }),
  portfolio: (id: string) => call<PortfolioDetail>(`/api/portfolios/${id}`),

  estimate: (code: string, buyPrice: number, sellPrice: number, qty: number) =>
    call<EstimateResult>(`/api/trades/estimate?code=${code}&buyPrice=${buyPrice}&sellPrice=${sellPrice}&qty=${qty}`),

  trade: (b: { portfolioId: string; code: string; side: "BUY" | "SELL"; price: number; qty: number; signalId?: string | null; stopLoss?: number | null; target?: number | null }) =>
    call<TradeResult>("/api/trades", { method: "POST", body: JSON.stringify(b) }),

  trades: (portfolioId: string) =>
    call<{ items: { trade_id: string; code: string; side: string; price: number; qty: number; traded_at: number; fee: number; tax: number; slippage: number }[] }>(
      `/api/trades?portfolioId=${portfolioId}`),

  performance: (portfolioId: string) => call<Performance>(`/api/performance/${portfolioId}`),

  watchlist: () => call<{ items: WatchItem[] }>("/api/watchlist"),
  addWatch: (code: string) => call<{ code: string }>("/api/watchlist", { method: "POST", body: JSON.stringify({ code }) }),
  removeWatch: (code: string) => call<{ code: string }>(`/api/watchlist?code=${code}`, { method: "DELETE" }),

  events: (code: string) => call<{ items: MarketEvent[]; labels: Record<string, string> }>(`/api/events/${code}`),
  addEvent: (code: string, date: string, kind: MarketEventKind, memo: string) =>
    call<{ code: string }>(`/api/events/${code}`, { method: "POST", body: JSON.stringify({ date, kind, memo }) }),
  removeEvent: (code: string, date: string, kind: MarketEventKind) =>
    call<{ removed: boolean }>(`/api/events/${code}?date=${date}&kind=${kind}`, { method: "DELETE" }),
};

export type PortfolioDetail = {
  portfolio: { portfolioId: string; name: string; initialCash: number; cash: number; createdAt: number };
  positions: {
    code: string; name: string; market: string; qty: number; avgPrice: number; lastPrice: number;
    value: number; unrealizedPnl: number; unrealizedRate: number; stopLoss: number | null; target: number | null;
  }[];
  marketValue: number; totalValue: number;
  concentration: { code: string; flag: { code: string; badge: string; reason: string } }[];
};

export type EstimateResult = {
  grossProfit: number; netProfit: number; netReturnRate: number; grossReturnRate: number;
  cost: { buyFee: number; sellFee: number; sellTax: number; slippage: number; total: number; totalRate: number };
  costWarning: boolean; costRatioOfGross: number | null;
  slippageRate: number; avgTradingValue: number; liquidityWarning: boolean;
};

export type TradeResult = {
  tradeId: string; cash: number;
  cost: { fee: number; tax: number; slippage: number };
  position: { qty: number; avgPrice: number };
  concentrationWarning: { code: string; badge: string; reason: string } | null;
};

export type WatchItem = {
  code: string; name: string; market: string | null; status: string[] | null;
  price: number | null; changeRate: number | null;
  lastSignal: { signalType: string; createdAt: number } | null;
};

import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { notFound, ok } from "../lib/response.js";
import { readCandles } from "../providers/index.js";
import { kstMidnight } from "../lib/time.js";
import type { Performance } from "@app/shared";

export const performance = new Hono<AppEnv>();

/**
 * GET /api/performance/:portfolioId
 * F8 성과 지표 + 벤치마크 병기(정규화 시작=100).
 * Buy&Hold 기준 종목은 `code` 쿼리로 지정하며, 생략 시 매수금액이 가장 큰 종목을 쓴다.
 */
performance.get("/:portfolioId", async (c) => {
  const portfolioId = c.req.param("portfolioId");
  const pf = await c.env.DB.prepare(
    `SELECT portfolio_id, initial_cash, cash, created_at FROM portfolios
      WHERE portfolio_id = ?1 AND user_id = ?2`,
  ).bind(portfolioId, c.get("userId")).first<{ portfolio_id: string; initial_cash: number; cash: number; created_at: number }>();
  if (!pf) return notFound(c, "포트폴리오를 찾을 수 없습니다.");

  const trRs = await c.env.DB.prepare(
    `SELECT code, side, price, qty, traded_at, fee, tax, slippage FROM trades
      WHERE portfolio_id = ?1 ORDER BY traded_at ASC LIMIT 2000`,
  ).bind(portfolioId).all<{ code: string; side: "BUY" | "SELL"; price: number; qty: number; traded_at: number; fee: number; tax: number; slippage: number }>();
  const tr = trRs.results ?? [];

  const now = Date.now();
  const startMs = tr.length ? kstMidnight(tr[0]!.traded_at) : kstMidnight(pf.created_at);
  const codes = [...new Set(tr.map((t) => t.code))];

  // 일별 종가 — SQL 로 잘라 가져온다(§2.2-3)
  const priceByCode = new Map<string, Map<number, number>>();
  for (const code of codes) {
    const rows = await readCandles(c.env, code, "1d", startMs - 10 * 86_400_000, now, 800);
    priceByCode.set(code, new Map(rows.map((r) => [kstMidnight(r.t), r.c])));
  }

  /* 거래 리플레이 → 일별 평가액 곡선 */
  const days: number[] = [];
  for (let d = startMs; d <= kstMidnight(now); d += 86_400_000) days.push(d);

  let cash = pf.initial_cash;
  let realized = 0;
  const holdings = new Map<string, { qty: number; avg: number }>();
  const closedReturns: number[] = [];
  let ti = 0;
  const equity: number[] = [];
  const lastKnown = new Map<string, number>();

  for (const day of days) {
    while (ti < tr.length && kstMidnight(tr[ti]!.traded_at) <= day) {
      const t = tr[ti]!;
      const h = holdings.get(t.code) ?? { qty: 0, avg: 0 };
      if (t.side === "BUY") {
        const outflow = t.price * t.qty + t.fee + t.slippage;
        cash -= outflow;
        const q = h.qty + t.qty;
        h.avg = q > 0 ? (h.qty * h.avg + outflow) / q : 0;
        h.qty = q;
      } else {
        const inflow = t.price * t.qty - t.fee - t.tax - t.slippage;
        cash += inflow;
        const pnl = inflow - h.avg * t.qty;
        realized += pnl;
        if (h.avg > 0) closedReturns.push(pnl / (h.avg * t.qty));
        h.qty -= t.qty;
        if (h.qty <= 0) { h.qty = 0; h.avg = 0; }
      }
      holdings.set(t.code, h);
      ti++;
    }
    let mv = 0;
    for (const [code, h] of holdings) {
      if (h.qty <= 0) continue;
      const px = priceByCode.get(code)?.get(day) ?? lastKnown.get(code) ?? h.avg;
      lastKnown.set(code, px);
      mv += px * h.qty;
    }
    equity.push(cash + mv);
  }

  const lastEquity = equity[equity.length - 1] ?? pf.initial_cash;
  const unrealized = lastEquity - cash - 0 - (realized - realized);  // 표시는 아래에서 재계산
  let marketValue = 0;
  let costBasis = 0;
  for (const [code, h] of holdings) {
    if (h.qty <= 0) continue;
    marketValue += (lastKnown.get(code) ?? h.avg) * h.qty;
    costBasis += h.avg * h.qty;
  }

  /* 벤치마크 — 정규화(시작=100) */
  const indexCode = "KOSPI";
  const idxRows = await readCandles(c.env, indexCode, "1d", startMs - 10 * 86_400_000, now, 800);
  const idxMap = new Map(idxRows.map((r) => [kstMidnight(r.t), r.c]));

  const bhCode = c.req.query("code") ?? pickMainCode(tr);
  const bhMap = bhCode ? priceByCode.get(bhCode) ?? new Map<number, number>() : new Map<number, number>();

  const norm = (series: (number | undefined)[], base: number | undefined): number[] => {
    if (!base || base <= 0) return series.map(() => 100);
    let prev = 100;
    return series.map((v) => { if (v === undefined || v <= 0) return prev; prev = (v / base) * 100; return prev; });
  };
  const idxSeries = days.map((d) => idxMap.get(d));
  const bhSeries = days.map((d) => bhMap.get(d));

  const portfolioNorm = equity.map((v) => (pf.initial_cash > 0 ? (v / pf.initial_cash) * 100 : 100));
  const indexNorm = norm(idxSeries, firstDefined(idxSeries));
  const bhNorm = norm(bhSeries, firstDefined(bhSeries));

  const cumulativeReturn = pf.initial_cash > 0 ? lastEquity / pf.initial_cash - 1 : 0;
  const bhReturn = (bhNorm[bhNorm.length - 1] ?? 100) / 100 - 1;
  const diffPp = (cumulativeReturn - bhReturn) * 100;

  const wins = closedReturns.filter((r) => r > 0);
  const losses = closedReturns.filter((r) => r <= 0);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

  const result: Performance = {
    portfolioId,
    totalValue: Math.round(lastEquity),
    cash: Math.round(cash),
    marketValue: Math.round(marketValue),
    realizedPnl: Math.round(realized),
    unrealizedPnl: Math.round(marketValue - costBasis),
    cumulativeReturn,
    mdd: maxDrawdown(equity),
    winRate: closedReturns.length ? wins.length / closedReturns.length : null,
    avgWinLossRatio: avgLoss > 0 ? avgWin / avgLoss : null,
    tradeCount: tr.length,
    closedCount: closedReturns.length,
    benchmark: {
      dates: days,
      portfolio: portfolioNorm,
      index: indexNorm,
      indexName: "코스피",
      buyAndHold: bhNorm,
      buyAndHoldName: bhCode ? `${bhCode} 단순보유` : "단순보유(기준 종목 없음)",
    },
    // "매매를 하지 않았을 때보다 나은가" 를 한 줄로 명시한다(§F8).
    verdict: bhCode
      ? `Buy&Hold 대비 ${diffPp >= 0 ? "+" : ""}${diffPp.toFixed(1)}%p — ${diffPp >= 0 ? "매매가 수익에 기여함" : "매매가 수익을 훼손함"}`
      : "비교 기준 종목이 없어 Buy&Hold 대비 판정을 생략합니다.",
  };
  void unrealized;
  return ok(c, result);
});

function pickMainCode(tr: { code: string; side: string; price: number; qty: number }[]): string | null {
  const amount = new Map<string, number>();
  for (const t of tr) if (t.side === "BUY") amount.set(t.code, (amount.get(t.code) ?? 0) + t.price * t.qty);
  let best: string | null = null;
  let max = 0;
  for (const [code, a] of amount) if (a > max) { max = a; best = code; }
  return best;
}

function firstDefined(xs: (number | undefined)[]): number | undefined {
  for (const x of xs) if (x !== undefined && x > 0) return x;
  return undefined;
}

export function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

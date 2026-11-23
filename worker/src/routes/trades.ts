import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, notFound, ok } from "../lib/response.js";
import { uid } from "../lib/mail.js";
import { executionCost, expectedReturn, slippageRate } from "../analysis/cost.js";
import { checkConcentration } from "../analysis/safety.js";
import { loadMasterWithFallback } from "../providers/master.js";
import { latestQuotes } from "./symbols.js";
import type { Market } from "@app/shared";

export const trades = new Hono<AppEnv>();

/** GET /api/trades/estimate — F7 비용 반영 예상수익률 (주문 전 계산) */
trades.get("/estimate", async (c) => {
  const code = c.req.query("code") ?? "";
  const buyPrice = Number(c.req.query("buyPrice"));
  const sellPrice = Number(c.req.query("sellPrice"));
  const qty = Math.floor(Number(c.req.query("qty")));
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  if (!(buyPrice > 0) || !(sellPrice > 0) || !(qty > 0)) return badRequest(c, "buyPrice·sellPrice·qty 는 양수여야 합니다.");

  const doc = await loadMasterWithFallback(c.env);
  const entry = doc.entries.find((e) => e.code === code);
  if (!entry) return notFound(c, "등록되지 않은 종목입니다.");
  const avgTradingValue = entry.avgTradingValue ?? 0;

  const result = expectedReturn({ market: entry.market, buyPrice, sellPrice, qty, avgTradingValue });
  return ok(c, {
    ...result,
    slippageRate: slippageRate(avgTradingValue),
    avgTradingValue,
    // S4 — 유동성 부족 종목은 슬리피지 경고를 함께 띄운다.
    liquidityWarning: avgTradingValue > 0 && avgTradingValue < 3_000_000_000,
  });
});

/** POST /api/trades — 모의 체결. 비용(수수료·세금·슬리피지)을 반드시 반영한다. */
trades.post("/", async (c) => {
  const b = await readJson<{
    portfolioId?: string; code?: string; side?: "BUY" | "SELL"; price?: number; qty?: number;
    signalId?: string | null; stopLoss?: number | null; target?: number | null; tradedAt?: number;
  }>(c.req);

  const portfolioId = b.portfolioId ?? "";
  const code = b.code ?? "";
  const side = b.side === "SELL" ? "SELL" : "BUY";
  const price = Number(b.price);
  const qty = Math.floor(Number(b.qty));
  if (!portfolioId) return badRequest(c, "portfolioId 필요");
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  if (!(price > 0) || !(qty > 0)) return badRequest(c, "price·qty 는 양수여야 합니다.");

  const pf = await c.env.DB.prepare(
    `SELECT portfolio_id, cash FROM portfolios WHERE portfolio_id = ?1 AND user_id = ?2`,
  ).bind(portfolioId, c.get("userId")).first<{ portfolio_id: string; cash: number }>();
  if (!pf) return notFound(c, "포트폴리오를 찾을 수 없습니다.");

  const doc = await loadMasterWithFallback(c.env);
  const entry = doc.entries.find((e) => e.code === code);
  if (!entry) return notFound(c, "등록되지 않은 종목입니다.");
  const market: Market = entry.market;
  const avgTradingValue = entry.avgTradingValue ?? 0;

  const cost = executionCost(side, market, price, qty, avgTradingValue);
  const amount = price * qty;
  const pos = await c.env.DB.prepare(
    `SELECT qty, avg_price FROM positions WHERE portfolio_id = ?1 AND code = ?2`,
  ).bind(portfolioId, code).first<{ qty: number; avg_price: number }>();

  let newCash: number;
  let newQty: number;
  let newAvg: number;

  if (side === "BUY") {
    const outflow = amount + cost.fee + cost.slippage;
    if (outflow > pf.cash) return badRequest(c, `현금 부족: 필요 ${Math.round(outflow).toLocaleString("ko-KR")}원 / 보유 ${Math.round(pf.cash).toLocaleString("ko-KR")}원`);
    newCash = pf.cash - outflow;
    const prevQty = pos?.qty ?? 0;
    const prevAvg = pos?.avg_price ?? 0;
    newQty = prevQty + qty;
    // 평균단가에 매수 비용을 포함해 실질 원가를 반영한다.
    newAvg = (prevQty * prevAvg + amount + cost.fee + cost.slippage) / newQty;
  } else {
    if (!pos || pos.qty < qty) return badRequest(c, `보유 수량 부족: 보유 ${pos?.qty ?? 0}주`);
    newCash = pf.cash + amount - cost.fee - cost.tax - cost.slippage;
    newQty = pos.qty - qty;
    newAvg = newQty > 0 ? pos.avg_price : 0;
  }

  const tradeId = uid("trd");
  const tradedAt = Number(b.tradedAt) || Date.now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO trades (trade_id, portfolio_id, code, side, price, qty, traded_at, fee, tax, slippage, signal_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(tradeId, portfolioId, code, side, price, qty, tradedAt, cost.fee, cost.tax, cost.slippage, b.signalId ?? null),
    c.env.DB.prepare(`UPDATE portfolios SET cash = ?2 WHERE portfolio_id = ?1`).bind(portfolioId, Math.round(newCash)),
    newQty > 0
      ? c.env.DB.prepare(
        `INSERT INTO positions (portfolio_id, code, qty, avg_price, stop_loss, target)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(portfolio_id, code) DO UPDATE SET qty = ?3, avg_price = ?4,
           stop_loss = COALESCE(?5, positions.stop_loss), target = COALESCE(?6, positions.target)`,
      ).bind(portfolioId, code, newQty, newAvg, b.stopLoss ?? null, b.target ?? null)
      : c.env.DB.prepare(`DELETE FROM positions WHERE portfolio_id = ?1 AND code = ?2`).bind(portfolioId, code),
  ];
  await c.env.DB.batch(stmts);

  // S7 — 체결 후 단일 종목 비중 경고
  const quotes = await latestQuotes(c.env, [code]);
  const last = quotes.get(code)?.price ?? price;
  const allPos = await c.env.DB.prepare(
    `SELECT code, qty, avg_price FROM positions WHERE portfolio_id = ?1`,
  ).bind(portfolioId).all<{ code: string; qty: number; avg_price: number }>();
  const totalValue = Math.round(newCash) + (allPos.results ?? []).reduce((s, p) => s + p.qty * p.avg_price, 0);
  const warning = checkConcentration(newQty * last, totalValue);

  return ok(c, {
    tradeId, side, code, price, qty, cost,
    cash: Math.round(newCash), position: { qty: newQty, avgPrice: newAvg },
    concentrationWarning: warning,
  }, 201);
});

/** GET /api/trades?portfolioId= */
trades.get("/", async (c) => {
  const portfolioId = c.req.query("portfolioId") ?? "";
  if (!portfolioId) return badRequest(c, "portfolioId 필요");
  const owns = await c.env.DB.prepare(
    `SELECT 1 AS x FROM portfolios WHERE portfolio_id = ?1 AND user_id = ?2`,
  ).bind(portfolioId, c.get("userId")).first();
  if (!owns) return notFound(c, "포트폴리오를 찾을 수 없습니다.");
  const rs = await c.env.DB.prepare(
    `SELECT trade_id, code, side, price, qty, traded_at, fee, tax, slippage, signal_id
       FROM trades WHERE portfolio_id = ?1 ORDER BY traded_at DESC LIMIT 500`,
  ).bind(portfolioId).all();
  return ok(c, { items: rs.results ?? [] });
});

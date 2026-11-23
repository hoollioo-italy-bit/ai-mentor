import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, notFound, ok } from "../lib/response.js";
import { uid } from "../lib/mail.js";
import { latestQuotes } from "./symbols.js";
import { checkConcentration } from "../analysis/safety.js";

export const portfolios = new Hono<AppEnv>();

/** GET /api/portfolios — 내 포트폴리오 목록 */
portfolios.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT portfolio_id, user_id, name, initial_cash, cash, created_at
       FROM portfolios WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`,
  ).bind(c.get("userId")).all();
  return ok(c, { items: rs.results ?? [] });
});

/** POST /api/portfolios — 초기자본 설정 */
portfolios.post("/", async (c) => {
  const body = await readJson<{ name?: string; initialCash?: number }>(c.req);
  const name = (body.name ?? "").trim() || "기본 포트폴리오";
  const initialCash = Math.floor(Number(body.initialCash ?? 10_000_000));
  if (!Number.isFinite(initialCash) || initialCash <= 0) return badRequest(c, "initialCash 는 양수여야 합니다.");
  const id = uid("pf");
  await c.env.DB.prepare(
    `INSERT INTO portfolios (portfolio_id, user_id, name, initial_cash, cash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
  ).bind(id, c.get("userId"), name, initialCash, Date.now()).run();
  return ok(c, { portfolioId: id, name, initialCash, cash: initialCash }, 201);
});

/** GET /api/portfolios/:id — 현금·보유종목·비중 경고(S7) */
portfolios.get("/:id", async (c) => {
  const id = c.req.param("id");
  const pf = await c.env.DB.prepare(
    `SELECT portfolio_id, user_id, name, initial_cash, cash, created_at
       FROM portfolios WHERE portfolio_id = ?1 AND user_id = ?2`,
  ).bind(id, c.get("userId")).first<{
    portfolio_id: string; user_id: string; name: string; initial_cash: number; cash: number; created_at: number;
  }>();
  if (!pf) return notFound(c, "포트폴리오를 찾을 수 없습니다.");

  const posRs = await c.env.DB.prepare(
    `SELECT p.code, p.qty, p.avg_price, p.stop_loss, p.target, s.name, s.market
       FROM positions p LEFT JOIN symbols s ON s.code = p.code
      WHERE p.portfolio_id = ?1 AND p.qty > 0`,
  ).bind(id).all<{
    code: string; qty: number; avg_price: number; stop_loss: number | null; target: number | null;
    name: string | null; market: string | null;
  }>();
  const rows = posRs.results ?? [];
  const quotes = await latestQuotes(c.env, rows.map((r) => r.code));

  const positions = rows.map((r) => {
    const last = quotes.get(r.code)?.price ?? r.avg_price;
    const value = last * r.qty;
    return {
      code: r.code, name: r.name ?? r.code, market: r.market ?? "KOSPI",
      qty: r.qty, avgPrice: r.avg_price, lastPrice: last, value,
      unrealizedPnl: (last - r.avg_price) * r.qty,
      unrealizedRate: r.avg_price > 0 ? (last - r.avg_price) / r.avg_price : 0,
      stopLoss: r.stop_loss, target: r.target,
    };
  });
  const marketValue = positions.reduce((s, p) => s + p.value, 0);
  const totalValue = pf.cash + marketValue;
  const concentration = positions
    .map((p) => ({ code: p.code, flag: checkConcentration(p.value, totalValue) }))
    .filter((x): x is { code: string; flag: NonNullable<ReturnType<typeof checkConcentration>> } => x.flag !== null);

  return ok(c, {
    portfolio: {
      portfolioId: pf.portfolio_id, name: pf.name, initialCash: pf.initial_cash,
      cash: pf.cash, createdAt: pf.created_at,
    },
    positions, marketValue, totalValue, concentration,
  });
});

import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, ok } from "../lib/response.js";
import { latestQuotes } from "./symbols.js";
import { loadMasterWithFallback } from "../providers/master.js";

export const watchlist = new Hono<AppEnv>();

/** GET /api/watchlist — 현재가·등락률·최근 시그널 요약 */
watchlist.get("/", async (c) => {
  const userId = c.get("userId");
  const rs = await c.env.DB.prepare(
    `SELECT code, added_at, last_seen FROM watchlist WHERE user_id = ?1 ORDER BY added_at DESC LIMIT 100`,
  ).bind(userId).all<{ code: string; added_at: number; last_seen: number }>();
  const rows = rs.results ?? [];
  if (rows.length === 0) return ok(c, { items: [] });

  const codes = rows.map((r) => r.code);
  const [doc, quotes] = await Promise.all([loadMasterWithFallback(c.env), latestQuotes(c.env, codes)]);
  const nameOf = new Map(doc.entries.map((e) => [e.code, e]));

  const ph = codes.map((_, i) => `?${i + 1}`).join(",");
  const sigRs = await c.env.DB.prepare(
    `SELECT code, signal_type, created_at FROM signals
      WHERE code IN (${ph}) ORDER BY created_at DESC LIMIT 200`,
  ).bind(...codes).all<{ code: string; signal_type: string; created_at: number }>();
  const lastSignal = new Map<string, { signalType: string; createdAt: number }>();
  for (const s of sigRs.results ?? []) {
    if (!lastSignal.has(s.code)) lastSignal.set(s.code, { signalType: s.signal_type, createdAt: s.created_at });
  }

  return ok(c, {
    items: rows.map((r) => {
      const e = nameOf.get(r.code);
      return {
        code: r.code, name: e?.name ?? r.code, market: e?.market ?? null, status: e?.status ?? null,
        addedAt: r.added_at, lastSeen: r.last_seen,
        ...(quotes.get(r.code) ?? { price: null, change: null, changeRate: null, asOf: null }),
        lastSignal: lastSignal.get(r.code) ?? null,
      };
    }),
  });
});

/** POST /api/watchlist { code } */
watchlist.post("/", async (c) => {
  const b = await readJson<{ code?: string }>(c.req);
  const code = b.code ?? "";
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO watchlist (user_id, code, added_at, last_seen) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(user_id, code) DO UPDATE SET last_seen = ?3`,
  ).bind(c.get("userId"), code, now).run();
  return ok(c, { code, addedAt: now }, 201);
});

/** DELETE /api/watchlist?code= */
watchlist.delete("/", async (c) => {
  const code = c.req.query("code") ?? "";
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  await c.env.DB.prepare(`DELETE FROM watchlist WHERE user_id = ?1 AND code = ?2`)
    .bind(c.get("userId"), code).run();
  return ok(c, { code, removed: true });
});

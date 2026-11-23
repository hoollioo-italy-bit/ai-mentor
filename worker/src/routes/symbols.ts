import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { badRequest, notFound, ok } from "../lib/response.js";
import { filterMaster, loadMasterWithFallback } from "../providers/index.js";
import { getProvider } from "../providers/index.js";
import type { Market } from "@app/shared";
import { log } from "../lib/logger.js";

export const symbols = new Hono<AppEnv>();

const MARKETS: Market[] = ["KOSPI", "KOSDAQ", "ETF", "ETN"];

/** F1 종목 검색 — KV 캐시 기반 부분일치(§3.4). D1 읽기 행을 소모하지 않는다. */
symbols.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length === 0) return ok(c, { items: [], masterUpdatedAt: 0 });
  if (q.length > 40) return badRequest(c, "검색어가 너무 깁니다.");
  const marketRaw = c.req.query("market");
  const market = marketRaw && MARKETS.includes(marketRaw as Market) ? (marketRaw as Market) : null;

  const doc = await loadMasterWithFallback(c.env);
  const hits = filterMaster(doc, q, market, 30);
  const quotes = await latestQuotes(c.env, hits.map((h) => h.code));

  return ok(c, {
    masterUpdatedAt: doc.updatedAt,
    items: hits.map((h) => ({
      code: h.code, name: h.name, market: h.market,
      status: h.status,                       // null = 상태 확인 불가 (S2)
      avgTradingValue: h.avgTradingValue,
      ...(quotes.get(h.code) ?? { price: null, change: null, changeRate: null, asOf: null }),
    })),
  });
});

/** F1 드릴다운 — 조회 시 watchlist.last_seen 갱신(§3.5 분봉 수집 대상 판정) */
symbols.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "종목코드 형식 오류");
  const doc = await loadMasterWithFallback(c.env);
  const entry = doc.entries.find((e) => e.code === code);
  if (!entry) return notFound(c, "등록되지 않은 종목입니다.");

  await touchLastSeen(c.env, c.get("userId"), code);

  let quote: { price: number; change: number; changeRate: number; t: number } | null = null;
  try { quote = await getProvider(c.env).getQuote(code); }
  catch (e) { log.warn("quote_failed", { code, error: String(e).slice(0, 200) }); }

  if (!quote) {
    const fallback = (await latestQuotes(c.env, [code])).get(code);
    if (fallback && fallback.price !== null) {
      quote = { price: fallback.price, change: fallback.change ?? 0, changeRate: fallback.changeRate ?? 0, t: fallback.asOf ?? Date.now() };
    }
  }
  return ok(c, { symbol: entry, quote, quoteSource: quote ? "live-or-cache" : null });
});

/** 검색 결과용 현재가·등락률 — 외부 호출 없이 D1 일봉에서 산출한다. */
export async function latestQuotes(
  env: AppEnv["Bindings"], codes: string[],
): Promise<Map<string, { price: number | null; change: number | null; changeRate: number | null; asOf: number | null }>> {
  const out = new Map<string, { price: number | null; change: number | null; changeRate: number | null; asOf: number | null }>();
  if (codes.length === 0) return out;
  const placeholders = codes.map((_, i) => `?${i + 1}`).join(",");
  const since = Date.now() - 40 * 86_400_000;
  const rs = await env.DB.prepare(
    `SELECT code, t, c FROM candles
      WHERE interval = '1d' AND t >= ?${codes.length + 1} AND code IN (${placeholders})
      ORDER BY code ASC, t DESC`,
  ).bind(...codes, since).all<{ code: string; t: number; c: number }>();

  const byCode = new Map<string, { t: number; c: number }[]>();
  for (const r of rs.results ?? []) {
    const arr = byCode.get(r.code) ?? [];
    if (arr.length < 2) arr.push({ t: r.t, c: r.c });
    byCode.set(r.code, arr);
  }
  for (const code of codes) {
    const rows = byCode.get(code);
    if (!rows || rows.length === 0) { out.set(code, { price: null, change: null, changeRate: null, asOf: null }); continue; }
    const last = rows[0]!;
    const prev = rows[1];
    const change = prev ? last.c - prev.c : 0;
    out.set(code, {
      price: last.c, change,
      changeRate: prev && prev.c !== 0 ? (change / prev.c) * 100 : 0,
      asOf: last.t,
    });
  }
  return out;
}

export async function touchLastSeen(env: AppEnv["Bindings"], userId: string, code: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO watchlist (user_id, code, added_at, last_seen) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(user_id, code) DO UPDATE SET last_seen = ?3`,
  ).bind(userId, code, now).run();
}

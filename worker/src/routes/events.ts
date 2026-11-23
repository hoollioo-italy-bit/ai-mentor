import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, ok } from "../lib/response.js";
import { EVENT_LABEL, type MarketEventKind } from "@app/shared";

export const events = new Hono<AppEnv>();

const KINDS: MarketEventKind[] = ["EARNINGS", "EX_DIVIDEND", "SPLIT", "ETC"];

/**
 * F11 이벤트 오버레이.
 * 실적발표·배당락 일정을 안정적으로 제공하는 무료 공개 소스를 확인하지 못했으므로
 * (§F11 단서) **수동 입력 UI 를 제공**한다. 자동 수집 소스를 확보하면 Cron 으로 교체한다.
 */
events.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  const rs = await c.env.DB.prepare(
    `SELECT code, date, kind, memo FROM events WHERE code = ?1 ORDER BY date DESC LIMIT 100`,
  ).bind(code).all();
  return ok(c, { items: rs.results ?? [], labels: EVENT_LABEL });
});

events.post("/:code", async (c) => {
  const code = c.req.param("code");
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  const b = await readJson<{ date?: string; kind?: MarketEventKind; memo?: string }>(c.req);
  const date = (b.date ?? "").trim();
  const kind = KINDS.includes(b.kind as MarketEventKind) ? b.kind! : "ETC";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(c, "date 는 YYYY-MM-DD 형식");

  await c.env.DB.prepare(
    `INSERT INTO events (code, date, kind, memo) VALUES (?1,?2,?3,?4)
     ON CONFLICT(code, date, kind) DO UPDATE SET memo = ?4`,
  ).bind(code, date, kind, (b.memo ?? "").slice(0, 200) || null).run();
  return ok(c, { code, date, kind }, 201);
});

events.delete("/:code", async (c) => {
  const code = c.req.param("code");
  const date = c.req.query("date") ?? "";
  const kind = c.req.query("kind") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !KINDS.includes(kind as MarketEventKind)) return badRequest(c, "date·kind 필요");
  await c.env.DB.prepare(`DELETE FROM events WHERE code = ?1 AND date = ?2 AND kind = ?3`)
    .bind(code, date, kind).run();
  return ok(c, { removed: true });
});

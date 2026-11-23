import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, ok } from "../lib/response.js";
import { log } from "../lib/logger.js";

/**
 * GAS 릴레이 전용(§7). Cloudflare Access 정책에서 **제외**하고
 * env.RELAY_TOKEN Bearer 검증으로만 보호한다.
 */
export const internal = new Hono<AppEnv>();

/** 1) Apps Script 가 5분 간격으로 호출 */
internal.get("/mail/pending", async (c) => {
  const limit = Math.min(20, Number(c.req.query("limit") ?? 10) || 10);
  const rs = await c.env.DB.prepare(
    `SELECT mail_id, to_addr, subject, html_body, created_at FROM mail_queue
      WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?1`,
  ).bind(limit).all();
  return ok(c, { items: rs.results ?? [] });
});

/** 2) 발송 성공 통보 */
internal.post("/mail/:id/sent", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(
    `UPDATE mail_queue SET status = 'SENT', sent_at = ?2 WHERE mail_id = ?1 AND status = 'PENDING'`,
  ).bind(id, Date.now()).run();
  log.info("mail_sent", { mailId: id, changed: r.meta?.changes ?? 0 });
  return ok(c, { mailId: id, status: "SENT" });
});

/** 3) 재시도 3회 후 실패 통보 (§7 산출물 요건) */
internal.post("/mail/:id/failed", async (c) => {
  const id = c.req.param("id");
  const b = await readJson<{ reason?: string }>(c.req);
  if (!id) return badRequest(c, "mailId 필요");
  await c.env.DB.prepare(
    `UPDATE mail_queue SET status = 'FAILED', sent_at = ?2 WHERE mail_id = ?1`,
  ).bind(id, Date.now()).run();
  log.error("mail_failed", { mailId: id, reason: (b.reason ?? "").slice(0, 300) });
  return ok(c, { mailId: id, status: "FAILED" });
});

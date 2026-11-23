import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, ok } from "../lib/response.js";
import { uid } from "../lib/mail.js";

export const alerts = new Hono<AppEnv>();

alerts.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT alert_id, code, kind, threshold, fired_at FROM alerts WHERE user_id = ?1 ORDER BY alert_id DESC LIMIT 200`,
  ).bind(c.get("userId")).all();
  return ok(c, { items: rs.results ?? [] });
});

/** POST /api/alerts { code, kind: STOP_LOSS|TARGET, threshold } */
alerts.post("/", async (c) => {
  const b = await readJson<{ code?: string; kind?: string; threshold?: number }>(c.req);
  const code = b.code ?? "";
  const kind = b.kind === "TARGET" ? "TARGET" : "STOP_LOSS";
  const threshold = Number(b.threshold);
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 형식 오류");
  if (!(threshold > 0)) return badRequest(c, "threshold 는 양수여야 합니다.");

  const id = uid("alt");
  await c.env.DB.prepare(
    `INSERT INTO alerts (alert_id, user_id, code, kind, threshold, fired_at) VALUES (?1,?2,?3,?4,?5,NULL)`,
  ).bind(id, c.get("userId"), code, kind, threshold).run();
  return ok(c, { alertId: id, code, kind, threshold }, 201);
});

alerts.delete("/", async (c) => {
  const id = c.req.query("alertId") ?? "";
  if (!id) return badRequest(c, "alertId 필요");
  await c.env.DB.prepare(`DELETE FROM alerts WHERE alert_id = ?1 AND user_id = ?2`)
    .bind(id, c.get("userId")).run();
  return ok(c, { alertId: id, removed: true });
});

import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { readJson } from "../lib/body.js";
import { badRequest, notFound, ok } from "../lib/response.js";
import { HORIZONS, SIGNAL_TYPE_LABEL, type Horizon, type SignalType } from "@app/shared";
import { allStats, saveSignal, statsFor, verificationSummary, SCORE_HORIZONS, type ScoreHorizon } from "../analysis/signals.js";
import { getCache, cacheKey } from "../analysis/build.js";
import { loadMasterWithFallback } from "../providers/master.js";

export const signals = new Hono<AppEnv>();

/** POST /api/signals — 현재 분석 캐시 기준으로 시그널을 명시 저장한다(F6 → F9). */
signals.post("/", async (c) => {
  const body = await readJson<{ code?: string; horizon?: Horizon }>(c.req);
  const code = body.code ?? "";
  const horizon = body.horizon ?? "1m";
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "code 필요");
  if (!HORIZONS.includes(horizon)) return badRequest(c, "horizon 오류");

  const payload = await getCache(c.env, cacheKey(code, horizon));
  if (!payload) return notFound(c, "분석 캐시가 없습니다. 먼저 /api/analysis 를 호출하십시오.");
  if (!payload.guide.available) return badRequest(c, payload.guide.message ?? "가이드가 생성되지 않아 저장할 수 없습니다.");

  const doc = await loadMasterWithFallback(c.env);
  const name = doc.entries.find((e) => e.code === code)?.name ?? code;
  const signalId = await saveSignal(c.env, {
    code, name, horizon, signalType: payload.guide.signalType,
    snapshot: payload.snapshot, regime: payload.regime, guide: payload.guide,
  });
  return ok(c, { signalId, signalType: payload.guide.signalType });
});

/**
 * GET /api/signals/stats?type=&days=
 * 모의투자 성과(F8)와 분리된, 가이드 자체의 성능 지표다(§F9).
 */
signals.get("/stats", async (c) => {
  const daysRaw = Number(c.req.query("days") ?? 20);
  const days = (SCORE_HORIZONS as readonly number[]).includes(daysRaw) ? (daysRaw as ScoreHorizon) : 20;
  const type = c.req.query("type") as SignalType | undefined;

  const [stats, verification] = await Promise.all([
    type ? statsFor(c.env, type, days).then((s) => [s]) : allStats(c.env, days),
    verificationSummary(c.env),
  ]);
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signals WHERE scored_d20 IS NULL`,
  ).first<{ n: number }>();

  return ok(c, {
    horizonDays: days,
    stats,
    labels: SIGNAL_TYPE_LABEL,
    verification,
    pendingScoring: pending?.n ?? 0,
  });
});

/** GET /api/signals?code= — 최근 시그널 이력 */
signals.get("/", async (c) => {
  const code = c.req.query("code");
  const limit = Math.min(100, Number(c.req.query("limit") ?? 30) || 30);
  const rs = code
    ? await c.env.DB.prepare(
      `SELECT signal_id, code, name, created_at, horizon, signal_type, entry, stop_loss, target,
              risk_reward, scored_d5, scored_d20, scored_d60
         FROM signals WHERE code = ?1 ORDER BY created_at DESC LIMIT ?2`).bind(code, limit).all()
    : await c.env.DB.prepare(
      `SELECT signal_id, code, name, created_at, horizon, signal_type, entry, stop_loss, target,
              risk_reward, scored_d5, scored_d20, scored_d60
         FROM signals ORDER BY created_at DESC LIMIT ?1`).bind(limit).all();
  return ok(c, { items: rs.results ?? [] });
});

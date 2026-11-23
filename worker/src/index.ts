import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Env } from "./lib/env.js";
import { accessUser, relayAuth } from "./lib/auth.js";
import { err, ok } from "./lib/response.js";
import { ERR, DISCLAIMER } from "@app/shared";
import { log } from "./lib/logger.js";
import { SchemaError } from "./providers/schema.js";
import { UpstreamError } from "./lib/http.js";

import { symbols } from "./routes/symbols.js";
import { candles } from "./routes/candles.js";
import { analysis } from "./routes/analysis.js";
import { market } from "./routes/market.js";
import { signals } from "./routes/signals.js";
import { portfolios } from "./routes/portfolios.js";
import { trades } from "./routes/trades.js";
import { performance as perf } from "./routes/performance.js";
import { watchlist } from "./routes/watchlist.js";
import { alerts } from "./routes/alerts.js";
import { events } from "./routes/events.js";
import { internal } from "./routes/internal.js";

import { syncSymbols } from "./cron/symbols.js";
import { ingestDaily, ingestMinutes } from "./cron/ingest.js";
import { precompute } from "./cron/precompute.js";
import { scoreSignals } from "./cron/score.js";
import { checkAlerts } from "./cron/alerts.js";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const origin = c.env.WEB_ORIGIN;
  const handler = cors({
    origin: origin ? origin.split(",").map((s) => s.trim()).filter(Boolean) : "*",
    allowHeaders: ["Content-Type", "Authorization", "Cf-Access-Authenticated-User-Email"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: Boolean(origin),
    maxAge: 600,
  });
  return handler(c, next);
});

app.get("/health", (c) => ok(c, { status: "ok", env: c.env.APP_ENV, provider: c.env.PRICE_PROVIDER, disclaimer: DISCLAIMER }));

/* /internal/* — Cloudflare Access 정책에서 제외하고 Bearer 로만 보호(§6) */
app.route("/internal", new Hono<AppEnv>().use("*", relayAuth).route("/", internal));

/* /api/* — Cloudflare Access 로 보호(§6) */
const api = new Hono<AppEnv>();
api.use("*", accessUser);
api.route("/symbols", symbols);
api.route("/candles", candles);
api.route("/analysis", analysis);
api.route("/market", market);
api.route("/signals", signals);
api.route("/portfolios", portfolios);
api.route("/trades", trades);
api.route("/performance", perf);
api.route("/watchlist", watchlist);
api.route("/alerts", alerts);
api.route("/events", events);
app.route("/api", api);

app.notFound((c) => err(c, ERR.NOT_FOUND, "경로를 찾을 수 없습니다.", 404));

app.onError((e, c) => {
  if (e instanceof SchemaError) {
    log.error("schema_error", { source: e.source, url: e.url, detail: e.detail });
    return err(c, ERR.UPSTREAM_SCHEMA, `외부 소스 응답 형식이 예상과 다릅니다 (${e.source}). 관리자에게 알림이 발송되었습니다.`, 502);
  }
  if (e instanceof UpstreamError) {
    log.error("upstream_error", { source: e.source, url: e.url, status: e.status });
    return err(c, ERR.UPSTREAM_FAILED, `외부 소스 호출에 실패했습니다 (${e.source}).`, 502);
  }
  log.error("unhandled", { error: String(e).slice(0, 500), stack: (e as Error).stack?.slice(0, 500) });
  return err(c, ERR.INTERNAL, "처리 중 오류가 발생했습니다.", 500);
});

/* ───────────── Cron Triggers (UTC, §8.2) ───────────── */

export const CRON = {
  SYMBOLS: "0 20 * * *",            // 05:00 KST — 종목마스터
  MINUTES: "*/10 0-6 * * 1-5",      // 장중 10분 — 분봉 축적(§3.5)
  DAILY: "0 7 * * 1-5",             // 16:00 KST — 일봉 + 사전 계산
  SCORE: "0 9 * * 1-5",             // 18:00 KST — F9 채점 ★명세 원문
  ALERTS: "*/30 0-6 * * 1-5",       // 장중 30분 — F10 알림 ★명세 원문
} as const;

export async function runCron(cron: string, env: Env, now = Date.now()): Promise<void> {
  const started = Date.now();
  try {
    switch (cron) {
      case CRON.SYMBOLS: await syncSymbols(env, now); break;
      case CRON.MINUTES: await ingestMinutes(env, now); break;
      case CRON.DAILY: await ingestDaily(env, now); await precompute(env, now); break;
      case CRON.SCORE: await scoreSignals(env, now); break;
      case CRON.ALERTS: await checkAlerts(env, now); break;
      default: log.warn("cron_unknown", { cron });
    }
    log.info("cron_done", { cron, elapsedMs: Date.now() - started });
  } catch (e) {
    log.error("cron_failed", { cron, error: String(e).slice(0, 500) });
    throw e;
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(event.cron, env));
  },
};

export { app };

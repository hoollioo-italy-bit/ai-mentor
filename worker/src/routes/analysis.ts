import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { badRequest, notFound, ok, err } from "../lib/response.js";
import { ERR, HORIZON_CONFIG, HORIZONS, type Horizon } from "@app/shared";
import { buildAnalysis, cacheKey, getCache, putCache } from "../analysis/build.js";
import { loadMasterWithFallback } from "../providers/master.js";
import { saveSignal } from "../analysis/signals.js";
import { touchLastSeen } from "./symbols.js";
import { log, measureAsync } from "../lib/logger.js";
import { isYoung } from "../analysis/safety.js";

export const analysis = new Hono<AppEnv>();

/** 장중에는 10분, 장 마감 후에는 다음 날까지 캐시를 유지한다. */
const TTL_MS = 10 * 60 * 1000;

/**
 * GET /api/analysis/:code?horizon=
 * analysis_cache 우선 조회(§6). 캐시 미스일 때만 산출하고 즉시 저장한다.
 */
analysis.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!/^[0-9A-Z]{6}$/.test(code)) return badRequest(c, "종목코드 형식 오류");

  const horizon = (c.req.query("horizon") ?? "1m") as Horizon;
  if (!HORIZONS.includes(horizon)) return badRequest(c, `horizon 은 ${HORIZONS.join("|")} 중 하나`);

  const accountValue = Math.max(0, Number(c.req.query("accountValue") ?? 10_000_000) || 10_000_000);
  const refresh = c.req.query("refresh") === "1";

  const doc = await loadMasterWithFallback(c.env);
  const entry = doc.entries.find((e) => e.code === code);
  if (!entry) return notFound(c, "등록되지 않은 종목입니다.");

  // S6 — 상장 1년 미만 종목은 장기 지표가 필요한 기간 선택을 차단한다.
  if (HORIZON_CONFIG[horizon].requiresLongHistory && isYoung(entry.listedAt, Date.now())) {
    return err(c, ERR.BLOCKED_BY_SAFETY,
      `상장 1년 미만 종목은 '${HORIZON_CONFIG[horizon].label}' 기간을 선택할 수 없습니다. (S6)`, 409,
      { code: "S6", listedAt: entry.listedAt });
  }

  await touchLastSeen(c.env, c.get("userId"), code);

  const key = cacheKey(code, horizon);
  if (!refresh) {
    const cached = await getCache(c.env, key);
    if (cached) {
      log.info("analysis_cache_hit", { code, horizon });
      return ok(c, { ...cached, cached: true });
    }
  }

  // 캐시 미스 — 요청 경로에서 산출한다. 이 경로가 8ms 를 넘으면 Cron 사전 계산 범위를
  // 넓혀야 한다(§2.2-4). Cron(cron/precompute.ts)이 관심종목을 미리 채워 두는 이유다.
  const payload = await measureAsync(`GET /api/analysis/${horizon}`, () =>
    buildAnalysis(c.env, entry, horizon, { accountValue }));

  await putCache(c.env, key, payload, TTL_MS);

  // F6 단서 — 가이드가 생성되면 signals 레코드를 즉시 저장한다(F9 의 전제).
  if (payload.guide.available) {
    await saveSignal(c.env, {
      code, name: entry.name, horizon, signalType: payload.guide.signalType,
      snapshot: payload.snapshot, regime: payload.regime, guide: payload.guide,
    });
  }
  return ok(c, { ...payload, cached: false });
});

/**
 * 지표·주석·해석·가이드 사전 계산(§2.2-1).
 * 요청 경로에서 무거운 계산을 하지 않도록 analysis_cache 를 미리 채운다.
 */

import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { HORIZONS, type Horizon } from "@app/shared";
import { buildAnalysis, cacheKey, putCache } from "../analysis/build.js";
import { loadMasterWithFallback } from "../providers/master.js";
import { selectIngestTargets } from "./ingest.js";
import { saveSignal } from "../analysis/signals.js";
import { cacheRegime } from "../analysis/regime.js";

/** 사전 계산 기간 — 전 기간을 돌면 D1 쓰기가 과도하므로 상위 4개만 채운다. */
export const PRECOMPUTE_HORIZONS: Horizon[] = ["1d", "1w", "1m", "3m"];
/** 장 마감 후 캐시는 다음 영업일 개장까지 유효 */
const TTL_MS = 18 * 60 * 60 * 1000;

export async function precompute(env: Env, now = Date.now()): Promise<void> {
  await cacheRegime(env, now);

  const { selected } = await selectIngestTargets(env, now);
  if (selected.length === 0) { log.info("precompute_skip", { reason: "대상 없음" }); return; }

  const doc = await loadMasterWithFallback(env);
  const byCode = new Map(doc.entries.map((e) => [e.code, e]));
  let built = 0;
  let signals = 0;

  for (const code of selected) {
    const entry = byCode.get(code);
    if (!entry) continue;
    for (const horizon of PRECOMPUTE_HORIZONS) {
      if (!HORIZONS.includes(horizon)) continue;
      try {
        const payload = await buildAnalysis(env, entry, horizon, { now });
        await putCache(env, cacheKey(code, horizon, now), payload, TTL_MS);
        built++;
        // F9 의 전제 — 가이드가 생성된 시점의 시그널을 즉시 박제한다.
        if (payload.guide.available) {
          const id = await saveSignal(env, {
            code, name: entry.name, horizon, signalType: payload.guide.signalType,
            snapshot: payload.snapshot, regime: payload.regime, guide: payload.guide, createdAt: now,
          });
          if (id) signals++;
        }
      } catch (e) {
        log.warn("precompute_failed", { code, horizon, error: String(e).slice(0, 200) });
      }
    }
  }
  await env.DB.prepare(`DELETE FROM analysis_cache WHERE expires_at < ?1`).bind(now - 86_400_000).run();
  log.info("precompute_done", { targets: selected.length, built, signals });
}

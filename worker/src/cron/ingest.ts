/**
 * 시세 축적 Cron.
 *
 * §3.5 분봉 축적 범위 제한(필수)
 *   대상 = 관심종목(watchlist) ∪ 최근 30일 내 1회 이상 조회된 종목, **상한 50종목**.
 *   초과 시 조회 빈도(last_seen)가 낮은 종목부터 자동 제외하고 그 사실을 로그로 남긴다.
 */

import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { getCandlesResilient, persistCandles } from "../providers/index.js";
import { loadMasterWithFallback, type MasterEntry } from "../providers/master.js";
import { getProvider } from "../providers/index.js";
import { INDEX_CODES } from "../analysis/regime.js";

export const MINUTE_SYMBOL_LIMIT = 50;
export const RECENT_WINDOW_MS = 30 * 86_400_000;

export async function selectIngestTargets(env: Env, now = Date.now()): Promise<{ selected: string[]; excluded: string[] }> {
  const rs = await env.DB.prepare(
    `SELECT code, MAX(last_seen) AS last_seen FROM watchlist
      WHERE last_seen >= ?1 GROUP BY code ORDER BY last_seen DESC`,
  ).bind(now - RECENT_WINDOW_MS).all<{ code: string; last_seen: number }>();
  const rows = rs.results ?? [];
  const selected = rows.slice(0, MINUTE_SYMBOL_LIMIT).map((r) => r.code);
  const excluded = rows.slice(MINUTE_SYMBOL_LIMIT).map((r) => r.code);

  if (excluded.length > 0) {
    log.warn("ingest_excluded", { count: excluded.length, codes: excluded.slice(0, 20), limit: MINUTE_SYMBOL_LIMIT });
    const stmt = env.DB.prepare(
      `INSERT INTO ingest_exclusion_log (code, reason, excluded_at) VALUES (?1, ?2, ?3)`,
    );
    const batch = excluded.map((code) => stmt.bind(code, `상한 ${MINUTE_SYMBOL_LIMIT}종목 초과 — 조회 빈도 하위`, now));
    for (let i = 0; i < batch.length; i += 100) await env.DB.batch(batch.slice(i, i + 100));
  }
  return { selected, excluded };
}

/** 장중 10분 간격 — 대상 종목의 1분봉을 적재한다. 5·30분봉은 조회 시 합성한다. */
export async function ingestMinutes(env: Env, now = Date.now()): Promise<void> {
  const { selected } = await selectIngestTargets(env, now);
  if (selected.length === 0) { log.info("ingest_minutes_skip", { reason: "대상 없음" }); return; }
  const doc = await loadMasterWithFallback(env);
  const byCode = new Map(doc.entries.map((e) => [e.code, e]));
  let okCount = 0;
  for (const code of selected) {
    const entry = byCode.get(code);
    if (!entry) continue;
    try {
      const res = await getCandlesResilient(env, entry, "1m", new Date(now - 2 * 86_400_000), new Date(now));
      if (res.candles.length > 0) okCount++;
    } catch (e) {
      log.warn("ingest_minute_failed", { code, error: String(e).slice(0, 200) });
    }
  }
  log.info("ingest_minutes_done", { targets: selected.length, ok: okCount });
}

/** 장 마감 후 — 관심종목 일봉 + 지수 일봉 적재. */
export async function ingestDaily(env: Env, now = Date.now()): Promise<void> {
  const { selected } = await selectIngestTargets(env, now);
  const doc = await loadMasterWithFallback(env);
  const byCode = new Map(doc.entries.map((e) => [e.code, e]));
  const from = new Date(now - 420 * 86_400_000);

  for (const code of selected) {
    const entry = byCode.get(code);
    if (!entry) continue;
    try { await getCandlesResilient(env, entry, "1d", from, new Date(now)); }
    catch (e) { log.warn("ingest_daily_failed", { code, error: String(e).slice(0, 200) }); }
  }

  // 지수 — 시장 국면(F5-5) 산출에 필수
  for (const code of [INDEX_CODES.KOSPI, INDEX_CODES.KOSDAQ]) {
    try {
      const candles = await getProvider(env).getCandles(code, "1d", from, new Date(now));
      await persistCandles(env, code, "1d", candles);
      log.info("ingest_index_done", { code, count: candles.length });
    } catch (e) {
      log.warn("ingest_index_failed", { code, error: String(e).slice(0, 200) });
    }
  }
  log.info("ingest_daily_done", { targets: selected.length });
}

export type { MasterEntry };

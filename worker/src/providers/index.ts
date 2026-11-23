/**
 * Provider 선택 + 폴백 체인(§8.1-3) + D1 영속화.
 * 앱의 나머지 부분은 이 모듈이 돌려주는 내부 표준 타입만 본다(§3.2-1).
 */

import type { Candle, Interval, PriceProvider, Freshness } from "@app/shared";
import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { notifySourceFailure, recordSourceOk } from "../lib/mail.js";
import { UpstreamError } from "../lib/http.js";
import { SchemaError } from "./schema.js";
import { createNaverProvider } from "./naver.js";
import { createKisProvider } from "./kis.js";
import { createMockProvider } from "./mock.js";
import { fetchDailyFallback } from "./krx.js";
import { filterMaster, loadMasterWithFallback, type MasterEntry } from "./master.js";
import { delayMinutes } from "../lib/time.js";
import { MAX_BARS } from "@app/shared";

export function providerName(env: Env): string {
  const p = (env.PRICE_PROVIDER || "naver").toLowerCase();
  return p === "kis" || p === "mock" ? p : "naver";
}

export function getProvider(env: Env): PriceProvider {
  const deps = {
    searchSymbols: async (keyword: string) => {
      const doc = await loadMasterWithFallback(env);
      return filterMaster(doc, keyword).map(({ code, name, market, providerKey, status }) => ({
        code, name, market, providerKey, status: status ?? undefined,
      }));
    },
  };
  switch (providerName(env)) {
    case "kis": return createKisProvider(env, deps);
    case "mock": return createMockProvider(deps);
    default: return createNaverProvider(deps);
  }
}

/* ───────────── D1 영속화 (정규화 포맷만 저장, §3.2-2) ───────────── */

export async function persistCandles(env: Env, code: string, interval: Interval, candles: Candle[]): Promise<number> {
  if (candles.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO candles (code, interval, t, o, h, l, c, v, va, adj)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(code, interval, t) DO UPDATE SET
       o = ?4, h = ?5, l = ?6, c = ?7, v = ?8, va = ?9, adj = ?10`,
  );
  const batch = candles.map((x) =>
    stmt.bind(code, interval, x.t, x.o, x.h, x.l, x.c, Math.round(x.v), Math.round(x.va ?? x.c * x.v), x.adj ? 1 : 0));
  // D1 배치 상한을 고려해 쪼갠다.
  const CHUNK = 200;
  for (let i = 0; i < batch.length; i += CHUNK) await env.DB.batch(batch.slice(i, i + CHUNK));
  return candles.length;
}

/** §2.2-3 — JS 필터링이 아니라 SQL WHERE·LIMIT 으로 잘라서 가져온다. */
export async function readCandles(
  env: Env, code: string, interval: Interval, from: number, to: number, limit?: number,
): Promise<Candle[]> {
  const cap = Math.min(limit ?? MAX_BARS[interval], MAX_BARS[interval]);
  const rs = await env.DB.prepare(
    `SELECT t, o, h, l, c, v, va, adj FROM candles
      WHERE code = ?1 AND interval = ?2 AND t >= ?3 AND t <= ?4
      ORDER BY t DESC LIMIT ?5`,
  ).bind(code, interval, from, to, cap)
    .all<{ t: number; o: number; h: number; l: number; c: number; v: number; va: number | null; adj: number }>();
  const rows = rs.results ?? [];
  rows.reverse();
  return rows.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, va: r.va ?? undefined, adj: r.adj === 1 }));
}

async function setIngestState(env: Env, code: string, interval: Interval, source: string, lastBarT: number | null, ok: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingest_state (code, interval, source, last_bar_t, fetched_at, ok)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(code, interval) DO UPDATE SET source = ?3, last_bar_t = ?4, fetched_at = ?5, ok = ?6`,
  ).bind(code, interval, source, lastBarT, Date.now(), ok ? 1 : 0).run();
}

export type CandleResult = { candles: Candle[]; freshness: Freshness };

/**
 * 폴백 체인(§8.1-3): 1차 Provider → KRX 일봉 폴백 → D1 캐시.
 * 캐시까지 내려가면 freshness.state = "STALE" 이고 화면에서 S1 이 발동한다.
 * 어떤 단계든 실패하면 조용히 넘어가지 않고 source_health 기록 + 관리자 알림을 남긴다.
 */
export async function getCandlesResilient(
  env: Env, symbol: MasterEntry, interval: Interval, from: Date, to: Date,
): Promise<CandleResult> {
  const primary = providerName(env);
  const now = Date.now();

  try {
    const candles = await getProvider(env).getCandles(symbol.code, interval, from, to);
    if (candles.length > 0) {
      await persistCandles(env, symbol.code, interval, candles);
      await recordSourceOk(env, primary);
      await setIngestState(env, symbol.code, interval, primary, candles[candles.length - 1]!.t, true);
      return { candles, freshness: fresh("LIVE", primary, candles, now) };
    }
    await reportFailure(env, primary, from, to, new SchemaError(primary, interval, "0건 반환(§8.1-2 감지 대상)", ""));
  } catch (e) {
    await reportFailure(env, primary, from, to, e);
  }

  if (interval === "1d" && symbol.providerKey) {
    try {
      const candles = await fetchDailyFallback(symbol.providerKey, from, to);
      if (candles.length > 0) {
        await persistCandles(env, symbol.code, interval, candles);
        await recordSourceOk(env, "krx");
        await setIngestState(env, symbol.code, interval, "krx", candles[candles.length - 1]!.t, true);
        log.warn("fallback_krx", { code: symbol.code, interval, count: candles.length });
        return { candles, freshness: fresh("FALLBACK", "krx", candles, now) };
      }
    } catch (e) {
      await reportFailure(env, "krx", from, to, e);
    }
  }

  const cached = await readCandles(env, symbol.code, interval, from.getTime(), to.getTime());
  await setIngestState(env, symbol.code, interval, "cache", cached.length ? cached[cached.length - 1]!.t : null, false);
  log.warn("fallback_cache", { code: symbol.code, interval, count: cached.length });
  return { candles: cached, freshness: fresh("STALE", "cache(D1)", cached, now) };
}

function fresh(state: Freshness["state"], source: string, candles: Candle[], now: number): Freshness {
  const lastBarAt = candles.length ? candles[candles.length - 1]!.t : null;
  return { state, source, lastBarAt, fetchedAt: now, delayMinutes: delayMinutes(now, lastBarAt) };
}

async function reportFailure(env: Env, source: string, from: Date, to: Date, e: unknown): Promise<void> {
  const detail =
    e instanceof SchemaError
      ? { url: e.url, status: 0, bodyHead: e.bodyHead, reason: `스키마 검증 실패: ${e.detail}` }
      : e instanceof UpstreamError
        ? { url: e.url, status: e.status, bodyHead: e.bodyHead, reason: "연속 호출 실패" }
        : { url: `${source}#${from.toISOString()}~${to.toISOString()}`, status: 0, bodyHead: String(e).slice(0, 300), reason: "알 수 없는 오류" };
  log.error("provider_failure", { source, ...detail });
  await notifySourceFailure(env, source, detail);
}

export { filterMaster, loadMasterWithFallback };
export type { MasterEntry };

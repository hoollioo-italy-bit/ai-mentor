/**
 * analysis_cache.payload 조립 — **Cron 사전 계산 전용 경로**(§2.2-1).
 * 요청 경로에서는 호출하지 않는다(요청은 캐시 읽기만 수행).
 */

import {
  DISCLAIMER, HORIZON_CONFIG, MAX_BARS,
  type AnalysisPayload, type Horizon, type MarketEvent, type TrendState,
} from "@app/shared";
import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { kstYmd } from "../lib/time.js";
import { getCandlesResilient, readCandles, type MasterEntry } from "../providers/index.js";
import { computeAll, snapshot, toSeries } from "./series.js";
import { buildAnnotations } from "./annotations.js";
import { buildRegime } from "./regime.js";
import { interpret } from "./interpret.js";
import { buildGuide, detectSignal } from "./guide.js";
import { evaluateSafety, isYoung } from "./safety.js";
import { statsFor, verificationSummary } from "./signals.js";
import { judgeTrend } from "./interpret.js";

export const cacheKey = (code: string, horizon: Horizon, now = Date.now()): string =>
  `${code}:${horizon}:${kstYmd(now)}`;

export type BuildOpts = { accountValue?: number; now?: number };

export async function buildAnalysis(env: Env, symbol: MasterEntry, horizon: Horizon, opts: BuildOpts = {}): Promise<AnalysisPayload> {
  const now = opts.now ?? Date.now();
  const cfg = HORIZON_CONFIG[horizon];
  const accountValue = opts.accountValue ?? 10_000_000;

  const primarySpanMs = spanMsFor(cfg.primary, cfg.primaryBars);
  const higherSpanMs = spanMsFor(cfg.higher, cfg.higherBars);

  const [primaryRes, higherRes, dailyForRs, events] = await Promise.all([
    getCandlesResilient(env, symbol, cfg.primary, new Date(now - primarySpanMs), new Date(now)),
    getCandlesResilient(env, symbol, cfg.higher, new Date(now - higherSpanMs), new Date(now)),
    readCandles(env, symbol.code, "1d", now - 400 * 86_400_000, now, 400),
    loadEvents(env, symbol.code),
  ]);

  const primaryCandles = primaryRes.candles.slice(-Math.min(cfg.primaryBars, MAX_BARS[cfg.primary]));
  const higherCandles = higherRes.candles.slice(-Math.min(cfg.higherBars, MAX_BARS[cfg.higher]));

  const longHistory = !isYoung(symbol.listedAt, now);
  const kPrimary = computeAll(primaryCandles, cfg.primary);
  const kHigher = computeAll(higherCandles, cfg.higher);
  const higherTrend: TrendState = higherCandles.length >= 20 ? judgeTrend(kHigher).state : "SIDEWAYS";

  const annotations = buildAnnotations(kPrimary, { events, longHistory });

  const avgTradingValue20 = avgVa(dailyForRs.map((c) => c.va ?? c.c * c.v), 20) ?? symbol.avgTradingValue;
  const regime = await buildRegime(env, symbol.market, dailyForRs.map((c) => c.c), now);
  const snap = snapshot(kPrimary, regime.rs, avgTradingValue20);

  const signalType = detectSignal(kPrimary, snap, annotations);
  const stat = signalType === "NONE" ? null : await statsFor(env, signalType, 20);

  const safety = evaluateSafety({
    freshness: primaryRes.freshness,
    status: symbol.status,
    sample: stat?.sample ?? 0,
    avgTradingValue: avgTradingValue20,
    riskReward: null,          // R:R 은 가이드 산출 후 buildGuide 내부에서 S5 로 추가된다
    listedAt: symbol.listedAt,
    config: cfg,
    now,
  });

  const guide = buildGuide({ k: kPrimary, snapshot: snap, annotations, safety, stat, accountValue });
  const interpretation = interpret({
    k: kPrimary, snapshot: snap, annotations,
    higherTrend, higherLabel: cfg.higherLabel, regimeText: regime.text,
  });
  const verification = await verificationSummary(env);

  const payload: AnalysisPayload = {
    schemaVersion: 1,
    symbol: { ...symbol, status: symbol.status ?? undefined, listedAt: symbol.listedAt, avgTradingValue: avgTradingValue20 },
    horizon,
    primary: {
      interval: cfg.primary, candles: primaryCandles,
      indicators: toSeries(kPrimary, { longHistory, prevClose: prevSessionClose(primaryCandles, cfg.primary) }),
    },
    higher: {
      interval: cfg.higher, label: cfg.higherLabel, candles: higherCandles,
      indicators: toSeries(kHigher, { longHistory, prevClose: null }), trend: higherTrend,
    },
    requestedIndicators: cfg.indicators,
    annotations,
    snapshot: snap,
    interpretation,
    regime,
    guide: { ...guide, blockedBy: guide.blockedBy ?? (safety.some((f) => f.blocking) ? safety : null) },
    safety,
    freshness: primaryRes.freshness,
    verification,
    disclaimer: DISCLAIMER,
    computedAt: now,
  };

  log.info("analysis_built", {
    code: symbol.code, horizon, primaryBars: primaryCandles.length, higherBars: higherCandles.length,
    annotations: annotations.length, signalType, guideAvailable: guide.available,
    freshness: primaryRes.freshness.state,
  });
  return payload;
}

/** 분봉은 장중 시간만 유효하므로 달력 기준으로 넉넉히 잡는다. */
function spanMsFor(interval: string, bars: number): number {
  const perDayBars: Record<string, number> = { "1m": 381, "5m": 77, "30m": 13, "1d": 1, "1w": 1 / 5, "1M": 1 / 21 };
  const per = perDayBars[interval] ?? 1;
  const days = Math.ceil(bars / per) * 1.6 + 7;   // 휴장일 여유 60%
  return Math.ceil(days) * 86_400_000;
}

function prevSessionClose(candles: { t: number; c: number }[], interval: string): number | null {
  if (interval !== "1m" && interval !== "5m" && interval !== "30m") return null;
  if (candles.length === 0) return null;
  const lastDay = kstYmd(candles[candles.length - 1]!.t);
  for (let i = candles.length - 1; i >= 0; i--) {
    if (kstYmd(candles[i]!.t) !== lastDay) return candles[i]!.c;
  }
  return null;
}

function avgVa(values: number[], window: number): number | null {
  const tail = values.slice(-window).filter((x) => Number.isFinite(x) && x > 0);
  if (tail.length === 0) return null;
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

export async function loadEvents(env: Env, code: string): Promise<MarketEvent[]> {
  const rs = await env.DB.prepare(
    `SELECT code, date, kind, memo FROM events WHERE code = ?1 ORDER BY date DESC LIMIT 60`,
  ).bind(code).all<{ code: string; date: string; kind: string; memo: string | null }>();
  return (rs.results ?? []).map((r) => ({ code: r.code, date: r.date, kind: r.kind as MarketEvent["kind"], memo: r.memo }));
}

/* ───────────── 캐시 입출력 ───────────── */

export async function putCache(env: Env, key: string, payload: AnalysisPayload, ttlMs: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO analysis_cache (cache_key, payload, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(cache_key) DO UPDATE SET payload = ?2, created_at = ?3, expires_at = ?4`,
  ).bind(key, JSON.stringify(payload), now, now + ttlMs).run();
}

export async function getCache(env: Env, key: string): Promise<AnalysisPayload | null> {
  const row = await env.DB.prepare(
    `SELECT payload FROM analysis_cache WHERE cache_key = ?1 AND expires_at > ?2`,
  ).bind(key, Date.now()).first<{ payload: string }>();
  if (!row) return null;
  try { return JSON.parse(row.payload) as AnalysisPayload; }
  catch { return null; }
}

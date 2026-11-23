/**
 * F9 시그널 저장 · 사후 채점 · 적중률 집계 — ★최우선 기능.
 * 가이드 생성 시 signals 레코드를 즉시 저장한다(F6 단서). 저장이 없으면 채점 자체가 불가능하다.
 */

import {
  MIN_SAMPLE, SIGNAL_TYPE_LABEL,
  type Guide, type Horizon, type IndicatorSnapshot, type MarketRegime,
  type ScoreResult, type SignalStat, type SignalType,
} from "@app/shared";
import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { uid } from "../lib/mail.js";
import { readCandles } from "../providers/index.js";

export const SCORE_HORIZONS = [5, 20, 60] as const;
export type ScoreHorizon = (typeof SCORE_HORIZONS)[number];
const COL: Record<ScoreHorizon, string> = { 5: "scored_d5", 20: "scored_d20", 60: "scored_d60" };

export type SaveSignalInput = {
  code: string;
  name: string;
  horizon: Horizon;
  signalType: SignalType;
  snapshot: IndicatorSnapshot;
  regime: MarketRegime;
  guide: Guide;
  createdAt?: number;
};

/**
 * 시그널 저장. 같은 종목·기간·유형은 KST 기준 하루 1건으로 제한한다
 * (migrations/0002 의 idx_signals_dedup). 중복이면 기존 signal_id 를 돌려준다.
 */
export async function saveSignal(env: Env, i: SaveSignalInput): Promise<string | null> {
  if (i.signalType === "NONE" || !i.guide.available) return null;
  const id = uid("sig");
  const createdAt = i.createdAt ?? Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO signals
         (signal_id, code, name, created_at, horizon, signal_type, indicators, market_regime,
          entry, stop_loss, target, risk_reward)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    ).bind(
      id, i.code, i.name, createdAt, i.horizon, i.signalType,
      JSON.stringify(i.snapshot), JSON.stringify({ kospi: i.regime.kospi.trend, kosdaq: i.regime.kosdaq.trend, rs: i.regime.rs }),
      i.guide.entry ? (i.guide.entry.low + i.guide.entry.high) / 2 : null,
      i.guide.stopLoss?.price ?? null, i.guide.target?.price ?? null, i.guide.riskReward ?? null,
    ).run();
    log.info("signal_saved", { signalId: id, code: i.code, horizon: i.horizon, signalType: i.signalType });
    return id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      const row = await env.DB.prepare(
        `SELECT signal_id FROM signals
          WHERE code = ?1 AND horizon = ?2 AND signal_type = ?3
            AND date(created_at/1000,'unixepoch','+9 hours') = date(?4/1000,'unixepoch','+9 hours')`,
      ).bind(i.code, i.horizon, i.signalType, createdAt).first<{ signal_id: string }>();
      return row?.signal_id ?? null;
    }
    throw e;
  }
}

/* ───────────── 사후 채점 ───────────── */

export type PendingSignal = {
  signal_id: string; code: string; created_at: number;
  entry: number | null; stop_loss: number | null; target: number | null;
};

export async function listDue(env: Env, days: ScoreHorizon, now: number, limit = 200): Promise<PendingSignal[]> {
  // 영업일 ≈ 달력일 × 1.45 로 보수적으로 환산해 "도래했을 가능성이 있는" 후보만 가져온다.
  const cutoff = now - Math.ceil(days * 1.45) * 86_400_000;
  const rs = await env.DB.prepare(
    `SELECT signal_id, code, created_at, entry, stop_loss, target
       FROM signals
      WHERE ${COL[days]} IS NULL AND created_at <= ?1
      ORDER BY created_at ASC LIMIT ?2`,
  ).bind(cutoff, limit).all<PendingSignal>();
  return rs.results ?? [];
}

/**
 * 일봉으로 실제 수익률·손절 선도달·목표 선도달을 계산한다.
 * 기준일 다음 영업일부터 `days` 개 봉을 본다. 봉이 모자라면 아직 채점하지 않는다(null).
 */
export async function scoreOne(env: Env, s: PendingSignal, days: ScoreHorizon, now: number): Promise<ScoreResult | null> {
  const entry = s.entry;
  if (entry === null || entry <= 0) return null;
  const to = Math.min(now, s.created_at + Math.ceil(days * 2.2) * 86_400_000);
  const candles = await readCandles(env, s.code, "1d", s.created_at + 1, to, days + 10);
  if (candles.length < days) return null;

  const window = candles.slice(0, days);
  let hitStop = false;
  let hitTarget = false;
  for (const c of window) {
    const stopTouched = s.stop_loss !== null && c.l <= s.stop_loss;
    const targetTouched = s.target !== null && c.h >= s.target;
    // 같은 봉에서 양쪽이 닿으면 보수적으로 손절 선도달로 간주한다(일봉은 순서를 알 수 없음).
    if (stopTouched) { hitStop = true; break; }
    if (targetTouched) { hitTarget = true; break; }
  }
  const exit = hitStop ? s.stop_loss! : hitTarget ? s.target! : window[window.length - 1]!.c;
  return { ret: (exit - entry) / entry, hitStop, hitTarget };
}

export async function writeScore(env: Env, signalId: string, days: ScoreHorizon, result: ScoreResult): Promise<void> {
  await env.DB.prepare(`UPDATE signals SET ${COL[days]} = ?2 WHERE signal_id = ?1`)
    .bind(signalId, JSON.stringify(result)).run();
}

/* ───────────── 집계 ───────────── */

type Agg = { n: number; hits: number; stops: number; sum: number };

export async function statsFor(env: Env, signalType: SignalType, days: ScoreHorizon = 20): Promise<SignalStat> {
  const rs = await env.DB.prepare(
    `SELECT ${COL[days]} AS s FROM signals WHERE signal_type = ?1 AND ${COL[days]} IS NOT NULL LIMIT 5000`,
  ).bind(signalType).all<{ s: string }>();
  return aggregate(signalType, days, rs.results ?? []);
}

export async function allStats(env: Env, days: ScoreHorizon = 20): Promise<SignalStat[]> {
  const rs = await env.DB.prepare(
    `SELECT signal_type AS k, ${COL[days]} AS s FROM signals WHERE ${COL[days]} IS NOT NULL LIMIT 20000`,
  ).all<{ k: string; s: string }>();
  const byType = new Map<string, { s: string }[]>();
  for (const r of rs.results ?? []) {
    const arr = byType.get(r.k) ?? [];
    arr.push({ s: r.s });
    byType.set(r.k, arr);
  }
  return [...byType.entries()]
    .map(([k, rows]) => aggregate(k as SignalType, days, rows))
    .sort((a, b) => b.sample - a.sample);
}

function aggregate(signalType: SignalType, days: ScoreHorizon, rows: { s: string }[]): SignalStat {
  const agg: Agg = { n: 0, hits: 0, stops: 0, sum: 0 };
  for (const r of rows) {
    let v: ScoreResult;
    try { v = JSON.parse(r.s) as ScoreResult; } catch { continue; }
    if (typeof v.ret !== "number") continue;
    agg.n++;
    agg.sum += v.ret;
    if (v.hitTarget || v.ret > 0) agg.hits++;
    if (v.hitStop) agg.stops++;
  }
  const insufficient = agg.n < MIN_SAMPLE;
  return {
    signalType,
    label: SIGNAL_TYPE_LABEL[signalType] ?? signalType,
    horizonDays: days,
    sample: agg.n,
    // S3 — 표본 30건 미만이면 수치를 만들지 않는다.
    hitRate: insufficient ? null : agg.hits / agg.n,
    avgReturn: insufficient ? null : agg.sum / agg.n,
    stopRate: insufficient ? null : agg.stops / agg.n,
    insufficient,
  };
}

/** §1.2 검증 현황 배지 — 전체 채점 건수와 적중률. 상시 노출용. */
export async function verificationSummary(env: Env): Promise<{ scored: number; hitRate: number | null }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN json_extract(scored_d20,'$.ret') > 0 THEN 1 ELSE 0 END) AS hits
       FROM signals WHERE scored_d20 IS NOT NULL`,
  ).first<{ n: number; hits: number | null }>();
  const n = row?.n ?? 0;
  return { scored: n, hitRate: n >= MIN_SAMPLE ? (row?.hits ?? 0) / n : null };
}

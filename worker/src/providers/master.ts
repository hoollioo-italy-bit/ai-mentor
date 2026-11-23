/**
 * 종목마스터 — 시세와 분리(§3.2-4).
 * 3~4천 건 전량을 KV 에 단일 JSON 으로 캐시하고(§3.4) 검색은 KV 에서 부분일치 필터한다.
 * D1 LIKE 보다 빠르고 D1 읽기 행 수를 소모하지 않는다.
 */

import type { Market, StockSymbol } from "@app/shared";
import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";

export const MASTER_KEY = "symbols:master:v2";

export type MasterEntry = Omit<StockSymbol, "status"> & {
  listedAt: string | null;
  avgTradingValue: number | null;
  /** null = 상태 동기화가 1회도 성공하지 않음 → S2 판정 불가 (undefined 를 쓰지 않는다) */
  status: string[] | null;
};

export type MasterDoc = { updatedAt: number; count: number; entries: MasterEntry[] };

export async function saveMaster(env: Env, entries: MasterEntry[]): Promise<void> {
  const doc: MasterDoc = { updatedAt: Date.now(), count: entries.length, entries };
  await env.KV.put(MASTER_KEY, JSON.stringify(doc));
  log.info("master_saved", { count: entries.length });
}

export async function loadMaster(env: Env): Promise<MasterDoc | null> {
  return await env.KV.get<MasterDoc>(MASTER_KEY, "json");
}

/** 종목마스터가 아직 없을 때 D1 에서 복구(최초 부팅·KV 유실 대비). */
export async function loadMasterWithFallback(env: Env): Promise<MasterDoc> {
  const kv = await loadMaster(env);
  if (kv && kv.entries.length > 0) return kv;
  const rs = await env.DB.prepare(
    `SELECT code, name, market, provider_key, status, listed_at, avg_trading_value, updated_at
       FROM symbols ORDER BY code LIMIT 5000`,
  ).all<{
    code: string; name: string; market: string; provider_key: string | null;
    status: string | null; listed_at: string | null; avg_trading_value: number | null; updated_at: number;
  }>();
  const entries: MasterEntry[] = (rs.results ?? []).map((r) => ({
    code: r.code, name: r.name, market: r.market as Market,
    providerKey: r.provider_key ?? undefined,
    listedAt: r.listed_at,
    avgTradingValue: r.avg_trading_value,
    status: r.status === null ? null : safeJson(r.status),
  }));
  log.warn("master_kv_miss_d1_fallback", { count: entries.length });
  return { updatedAt: 0, count: entries.length, entries };
}

function safeJson(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}

/** F1 부분일치 검색. 종목코드 완전일치 → 종목명 접두 → 종목명 부분일치 순으로 정렬. */
export function filterMaster(doc: MasterDoc, keyword: string, market?: Market | null, limit = 30): MasterEntry[] {
  const q = keyword.trim().toLowerCase();
  if (q === "") return [];
  const scored: { e: MasterEntry; score: number }[] = [];
  for (const e of doc.entries) {
    if (market && e.market !== market) continue;
    const name = e.name.toLowerCase();
    let score = -1;
    if (e.code.toLowerCase() === q) score = 0;
    else if (name === q) score = 1;
    else if (e.code.toLowerCase().startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 4;
    if (score >= 0) scored.push({ e, score });
    if (scored.length > limit * 20) break;
  }
  scored.sort((a, b) => a.score - b.score || a.e.name.length - b.e.name.length);
  return scored.slice(0, limit).map((s) => s.e);
}

export async function getSymbol(env: Env, code: string): Promise<MasterEntry | null> {
  const doc = await loadMasterWithFallback(env);
  return doc.entries.find((e) => e.code === code) ?? null;
}

/** 지수 코드 — 시장 국면(F5-5) 산출용. 네이버는 지수도 동일 차트 엔드포인트로 제공한다. */
export const INDEX_CODE = { KOSPI: "KOSPI", KOSDAQ: "KOSDAQ" } as const;

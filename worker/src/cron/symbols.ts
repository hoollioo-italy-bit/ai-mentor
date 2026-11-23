/**
 * 일 1회 — KRX 종목마스터 적재 → D1 + KV 캐시(§3.4).
 * 전종목 시세로 최근 20일 평균 거래대금(S4 판정)과 거래 상태(S2)를 보강한다.
 */

import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { BLD, fetchAllQuotes, fetchEtfEtnMaster, fetchStockMaster } from "../providers/krx.js";
import { saveMaster, type MasterEntry } from "../providers/master.js";
import { recordSourceOk, notifySourceFailure } from "../lib/mail.js";
import { kstYmd } from "../lib/time.js";
import { BLOCKING_STATUS } from "../analysis/safety.js";

export async function syncSymbols(env: Env, now = Date.now()): Promise<void> {
  let master: Awaited<ReturnType<typeof fetchStockMaster>>;
  try {
    master = await fetchStockMaster();
  } catch (e) {
    log.error("symbol_master_failed", { error: String(e).slice(0, 300) });
    await notifySourceFailure(env, "krx", {
      url: BLD.STOCK_MASTER, status: 0, bodyHead: String(e).slice(0, 300),
      reason: "종목마스터 적재 실패 — 검색과 S2 판정이 모두 멈춥니다.",
    });
    return;
  }
  const etf = await fetchEtfEtnMaster().catch(() => []);
  const all = [...master, ...etf];

  /* 거래대금·상태 보강 — 최근 영업일부터 거슬러 최대 5일 시도 */
  const quotes = new Map<string, { tradingValue: number; statusNote: string }>();
  for (let back = 0; back < 5 && quotes.size === 0; back++) {
    const ymd = kstYmd(now - back * 86_400_000);
    try {
      for (const q of await fetchAllQuotes(ymd)) quotes.set(q.code, { tradingValue: q.tradingValue, statusNote: q.statusNote });
      log.info("symbol_quotes_loaded", { trdDd: ymd, count: quotes.size });
    } catch (e) {
      log.warn("symbol_quotes_retry", { trdDd: ymd, error: String(e).slice(0, 200) });
    }
  }
  const statusSynced = quotes.size > 0;
  if (!statusSynced) {
    await notifySourceFailure(env, "krx", {
      url: BLD.STOCK_DAILY_ALL, status: 0, bodyHead: "",
      reason: "전종목 시세 조회 실패 — 거래 상태(S2) 확인 불가 상태가 유지됩니다.",
    });
  }

  /* 20일 평균 거래대금은 D1 일봉에서 직접 집계한다(단일 쿼리). */
  const since = now - 32 * 86_400_000;
  const avgRs = await env.DB.prepare(
    `SELECT code, AVG(va) AS avg_va FROM (
        SELECT code, va, ROW_NUMBER() OVER (PARTITION BY code ORDER BY t DESC) AS rn
          FROM candles WHERE interval = '1d' AND t >= ?1 AND va IS NOT NULL
      ) WHERE rn <= 20 GROUP BY code`,
  ).bind(since).all<{ code: string; avg_va: number }>();
  const avgMap = new Map((avgRs.results ?? []).map((r) => [r.code, Math.round(r.avg_va)]));

  const entries: MasterEntry[] = all.map((m) => {
    const q = quotes.get(m.code);
    const status = statusSynced ? parseStatus(q?.statusNote ?? "") : null;
    return {
      code: m.code, name: m.name, market: m.market, providerKey: m.providerKey,
      listedAt: m.listedAt,
      avgTradingValue: avgMap.get(m.code) ?? q?.tradingValue ?? null,
      status,
    };
  });

  await saveMaster(env, entries);

  const stmt = env.DB.prepare(
    `INSERT INTO symbols (code, name, market, provider_key, status, listed_at, avg_trading_value, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(code) DO UPDATE SET name=?2, market=?3, provider_key=?4, status=?5,
       listed_at=?6, avg_trading_value=?7, updated_at=?8`,
  );
  const batch = entries.map((e) => stmt.bind(
    e.code, e.name, e.market, e.providerKey ?? null,
    e.status === null ? null : JSON.stringify(e.status),
    e.listedAt, e.avgTradingValue, now,
  ));
  for (let i = 0; i < batch.length; i += 200) await env.DB.batch(batch.slice(i, i + 200));

  await recordSourceOk(env, "krx");
  log.info("symbols_synced", { total: entries.length, statusSynced, withAvgValue: avgMap.size });
}

/** KRX 상태 표기에서 차단 사유만 뽑는다. 동기화는 됐으나 사유가 없으면 빈 배열(정상). */
export function parseStatus(note: string): string[] {
  const hits = BLOCKING_STATUS.filter((b) => note.includes(b));
  return hits;
}

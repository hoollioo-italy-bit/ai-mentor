import type { Candle, Interval } from "@app/shared";
import { KST_OFFSET_MS, kstParts } from "../lib/time.js";

/**
 * 분봉 리샘플링.
 * 네이버는 1분봉만 제공하므로 5분·30분봉은 1분봉을 합성해 만든다(소스 제약에 따른 결정).
 * KIS 로 전환하면 네이티브 5분/30분봉을 쓸 수 있다 — docs/provider-migration.md 참조.
 */
export function resampleMinutes(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const buckets = new Map<number, Candle>();
  const order: number[] = [];
  for (const c of candles) {
    // KST 기준 자정으로부터의 경과 분을 bucket 으로 쓴다(세션 경계 보존).
    const kstMs = c.t + KST_OFFSET_MS;
    const dayStart = Math.floor(kstMs / 86_400_000) * 86_400_000;
    const minuteOfDay = Math.floor((kstMs - dayStart) / 60_000);
    const bucketStart = dayStart + Math.floor(minuteOfDay / minutes) * minutes * 60_000 - KST_OFFSET_MS;
    const cur = buckets.get(bucketStart);
    if (!cur) {
      buckets.set(bucketStart, { t: bucketStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, va: c.va ?? 0, adj: c.adj });
      order.push(bucketStart);
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
      cur.va = (cur.va ?? 0) + (c.va ?? 0);
      cur.adj = cur.adj && c.adj;
    }
  }
  order.sort((a, b) => a - b);
  return order.map((k) => buckets.get(k)!);
}

/** 일봉 → 주봉(월요일 시작) / 월봉. 소스가 주·월봉을 주지 못할 때의 폴백. */
export function resampleDaily(candles: Candle[], to: "1w" | "1M"): Candle[] {
  const keyOf = (t: number): number => {
    const p = kstParts(t);
    if (to === "1M") return Date.UTC(p.y, p.m - 1, 1) - KST_OFFSET_MS;
    const dayStart = Date.UTC(p.y, p.m - 1, p.d) - KST_OFFSET_MS;
    const offset = (p.dow + 6) % 7; // 월요일=0
    return dayStart - offset * 86_400_000;
  };
  const buckets = new Map<number, Candle>();
  const order: number[] = [];
  for (const c of candles) {
    const k = keyOf(c.t);
    const cur = buckets.get(k);
    if (!cur) {
      buckets.set(k, { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, va: c.va ?? 0, adj: c.adj });
      order.push(k);
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
      cur.va = (cur.va ?? 0) + (c.va ?? 0);
      cur.adj = cur.adj && c.adj;
    }
  }
  order.sort((a, b) => a - b);
  return order.map((k) => buckets.get(k)!);
}

export const INTRADAY: Interval[] = ["1m", "5m", "30m"];
export const isIntraday = (i: Interval): boolean => INTRADAY.includes(i);

export const INTERVAL_MINUTES: Record<Interval, number> = {
  "1m": 1, "5m": 5, "30m": 30, "1d": 1440, "1w": 10080, "1M": 43200,
};

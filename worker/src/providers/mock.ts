/**
 * 개발·테스트용 결정론적 Provider.
 * 외부 호출 없이 동일 입력에 대해 항상 같은 캔들을 생성한다.
 * PRICE_PROVIDER=mock 일 때만 선택된다. 운영에서 사용 금지.
 */

import type { Candle, Interval, PriceProvider, StockSymbol } from "@app/shared";
import { INTERVAL_MINUTES } from "./aggregate.js";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mockCandles(code: string, interval: Interval, from: Date, to: Date, max = 600): Candle[] {
  const stepMs = INTERVAL_MINUTES[interval] * 60_000;
  const count = Math.min(max, Math.max(1, Math.floor((to.getTime() - from.getTime()) / stepMs)));
  const rnd = mulberry32(hash(`${code}:${interval}`));
  let price = 10_000 + (hash(code) % 90_000);
  const out: Candle[] = [];
  const start = to.getTime() - count * stepMs;
  for (let i = 0; i < count; i++) {
    const drift = (rnd() - 0.48) * price * 0.012;
    const o = price;
    const c = Math.max(100, o + drift);
    const h = Math.max(o, c) * (1 + rnd() * 0.006);
    const l = Math.min(o, c) * (1 - rnd() * 0.006);
    const v = Math.floor(50_000 + rnd() * 500_000);
    out.push({
      t: start + i * stepMs,
      o: Math.round(o), h: Math.round(h), l: Math.round(l), c: Math.round(c),
      v, va: Math.round(c * v), adj: true,
    });
    price = c;
  }
  return out;
}

export function createMockProvider(deps: { searchSymbols: (k: string) => Promise<StockSymbol[]> }): PriceProvider {
  return {
    searchSymbols: deps.searchSymbols,
    async getCandles(code, interval, from, to) { return mockCandles(code, interval, from, to); },
    async getQuote(code) {
      const c = mockCandles(code, "1d", new Date(Date.now() - 30 * 86_400_000), new Date());
      const last = c[c.length - 1]!;
      const prev = c[c.length - 2] ?? last;
      const change = last.c - prev.c;
      return { price: last.c, change, changeRate: prev.c === 0 ? 0 : (change / prev.c) * 100, t: Date.now() };
    },
  };
}

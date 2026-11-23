import { z } from "zod";
import type { Candle } from "@app/shared";

/**
 * 어댑터는 반환 전 스키마 검증을 수행한다(§3.2-3).
 * 검증 실패 시 예외를 던진다 — 부분 데이터로 조용히 진행하지 않는다(§8.1-5).
 */

export class SchemaError extends Error {
  constructor(readonly source: string, readonly url: string, readonly detail: string, readonly bodyHead: string) {
    super(`${source} 응답 스키마 검증 실패: ${detail}`);
    this.name = "SchemaError";
  }
}

export const candleSchema = z.object({
  t: z.number().int().positive(),
  o: z.number().positive(),
  h: z.number().positive(),
  l: z.number().positive(),
  c: z.number().positive(),
  v: z.number().nonnegative(),
  va: z.number().nonnegative().optional(),
  adj: z.boolean(),
});

export const candleArraySchema = z.array(candleSchema);

export const quoteSchema = z.object({
  price: z.number().positive(),
  change: z.number(),
  changeRate: z.number(),
  t: z.number().int().positive(),
});

export const symbolSchema = z.object({
  code: z.string().regex(/^[0-9A-Z]{6}$/, "종목코드는 6자리"),
  name: z.string().min(1),
  market: z.enum(["KOSPI", "KOSDAQ", "ETF", "ETN"]),
  providerKey: z.string().optional(),
  status: z.array(z.string()).optional(),
});

export const symbolArraySchema = z.array(symbolSchema);

/** 필드 존재·타입 외에 **건수·시간 정렬**까지 검증한다(§3.2-3). */
export function validateCandles(
  source: string, url: string, raw: unknown, opts: { minCount?: number; bodyHead?: string } = {},
): Candle[] {
  const parsed = candleArraySchema.safeParse(raw);
  if (!parsed.success) {
    throw new SchemaError(source, url, parsed.error.issues.slice(0, 3).map(fmtIssue).join("; "), opts.bodyHead ?? "");
  }
  const rows = parsed.data;
  const min = opts.minCount ?? 1;
  if (rows.length < min) {
    throw new SchemaError(source, url, `건수 부족: ${rows.length} < ${min}`, opts.bodyHead ?? "");
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.t <= rows[i - 1]!.t) {
      throw new SchemaError(source, url, `시간 정렬 위반 index=${i} (${rows[i - 1]!.t} → ${rows[i]!.t})`, opts.bodyHead ?? "");
    }
  }
  for (const r of rows) {
    if (r.h < r.l || r.h < r.o || r.h < r.c || r.l > r.o || r.l > r.c) {
      throw new SchemaError(source, url, `OHLC 정합성 위반 t=${r.t} o=${r.o} h=${r.h} l=${r.l} c=${r.c}`, opts.bodyHead ?? "");
    }
  }
  return rows;
}

function fmtIssue(i: { path: PropertyKey[]; message: string }): string {
  return `${i.path.join(".") || "(root)"}: ${i.message}`;
}

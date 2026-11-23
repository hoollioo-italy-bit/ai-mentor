import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { badRequest, notFound, ok } from "../lib/response.js";
import { MAX_BARS, type Interval } from "@app/shared";
import { getCandlesResilient, readCandles } from "../providers/index.js";
import { loadMasterWithFallback } from "../providers/master.js";

export const candles = new Hono<AppEnv>();

const INTERVALS: Interval[] = ["1m", "5m", "30m", "1d", "1w", "1M"];

/**
 * GET /api/candles/:code?interval=&from=&to=
 * D1 에서 SQL WHERE·LIMIT 으로 잘라 읽는다(§2.2-3). 캐시에 없을 때만 외부 조회로 보충한다.
 */
candles.get("/:code", async (c) => {
  const code = c.req.param("code");
  if (!/^[0-9A-Z]{6}$|^KOSPI$|^KOSDAQ$/.test(code)) return badRequest(c, "종목코드 형식 오류");

  const interval = (c.req.query("interval") ?? "1d") as Interval;
  if (!INTERVALS.includes(interval)) return badRequest(c, `interval 은 ${INTERVALS.join("|")} 중 하나`);

  const to = parseTime(c.req.query("to")) ?? Date.now();
  const defaultSpan = interval === "1d" || interval === "1w" || interval === "1M" ? 400 : 10;
  const from = parseTime(c.req.query("from")) ?? to - defaultSpan * 86_400_000;
  if (from >= to) return badRequest(c, "from 이 to 보다 이후입니다.");

  const limit = Math.min(Number(c.req.query("limit") ?? MAX_BARS[interval]) || MAX_BARS[interval], MAX_BARS[interval]);

  let rows = await readCandles(c.env, code, interval, from, to, limit);
  let source = "cache";
  if (rows.length === 0) {
    const doc = await loadMasterWithFallback(c.env);
    const entry = doc.entries.find((e) => e.code === code);
    if (!entry) return notFound(c, "등록되지 않은 종목입니다.");
    const res = await getCandlesResilient(c.env, entry, interval, new Date(from), new Date(to));
    rows = res.candles.slice(-limit);
    source = res.freshness.source;
  }
  return ok(c, { code, interval, count: rows.length, source, candles: rows });
});

function parseTime(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d{10,}$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

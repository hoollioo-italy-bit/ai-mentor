import { Hono } from "hono";
import type { AppEnv } from "../lib/env.js";
import { ok } from "../lib/response.js";
import { computeRegimeBase, loadRegimeBase, RS_WINDOW_DAYS } from "../analysis/regime.js";

export const market = new Hono<AppEnv>();

/** GET /api/market/regime — KV 캐시 우선. 헤더에 상시 노출되므로 계산을 피한다(§2.2-1). */
market.get("/regime", async (c) => {
  const base = (await loadRegimeBase(c.env)) ?? (await computeRegimeBase(c.env));
  const strip = (s: { series: number[] }) => { const { series, ...rest } = s; return rest; };
  return ok(c, {
    kospi: strip(base.kospi), kosdaq: strip(base.kosdaq),
    rsWindowDays: RS_WINDOW_DAYS, asOf: base.asOf,
  });
});

import type { Context } from "hono";
import { ERR, type ErrCode } from "@app/shared";

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ ok: true as const, data }, status as never);
}

export function err(c: Context, code: ErrCode, message: string, status = 400, detail?: unknown) {
  return c.json({ ok: false as const, error: { code, message, detail } }, status as never);
}

export const badRequest = (c: Context, m: string) => err(c, ERR.BAD_REQUEST, m, 400);
export const notFound = (c: Context, m: string) => err(c, ERR.NOT_FOUND, m, 404);
export const unauthorized = (c: Context, m: string) => err(c, ERR.UNAUTHORIZED, m, 401);
export const internal = (c: Context, m: string, d?: unknown) => err(c, ERR.INTERNAL, m, 500, d);

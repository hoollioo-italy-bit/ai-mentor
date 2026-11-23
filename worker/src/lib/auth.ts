import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import { unauthorized } from "./response.js";

/**
 * /api/* 는 Cloudflare Access 로 보호한다(§6). Access 를 통과한 요청에는
 * `Cf-Access-Authenticated-User-Email` 헤더가 주입된다.
 * 로컬 개발(wrangler dev)에는 헤더가 없으므로 DEV_USER 로 대체한다.
 */
export const accessUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.req.header("Cf-Access-Authenticated-User-Email");
  if (email) { c.set("userId", email); return next(); }
  if (c.env.APP_ENV !== "production") { c.set("userId", c.env.DEV_USER || "dev@local"); return next(); }
  return unauthorized(c, "Cloudflare Access 인증 정보가 없습니다.");
};

/** /internal/* 전용 Bearer 검증(§6). Access 정책에서 제외된 경로이므로 토큰이 유일한 방어선이다. */
export const relayAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.RELAY_TOKEN;
  if (!expected) return unauthorized(c, "RELAY_TOKEN 미설정");
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(token, expected)) return unauthorized(c, "릴레이 토큰이 올바르지 않습니다.");
  return next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

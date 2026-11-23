/** 모든 API 응답 공통 포맷 — 명세 §6 */
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: { code: string; message: string; detail?: unknown } };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const ERR = {
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  UPSTREAM_SCHEMA: "UPSTREAM_SCHEMA",
  UPSTREAM_FAILED: "UPSTREAM_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  BLOCKED_BY_SAFETY: "BLOCKED_BY_SAFETY",
  INTERNAL: "INTERNAL",
} as const;
export type ErrCode = (typeof ERR)[keyof typeof ERR];

/**
 * 구조화 로깅(§8.2). 외부 호출은 소요시간·상태코드를, 각 엔드포인트는 계산 시간을 기록한다.
 *
 * 주의: Workers 런타임은 타이밍 사이드채널 대응으로 동기 연산 중 타이머를 진행시키지 않는다.
 * 따라서 `computeMs` 는 **하한값**이며, 권위 있는 CPU 사용량은 Workers Logs 의 `cpuTime`
 * 필드(observability.logs 활성화 시 자동 수집)를 본다. §2.2-4 의 8ms 임계 판정에는
 * 두 값을 함께 사용한다.
 */

export const CPU_BUDGET_MS = 10;
export const CPU_WARN_MS = 8;

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}) => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}) => emit("error", event, fields),
};

/** 엔드포인트 계산 시간 측정. 8ms 초과 시 경고 로그 → Cron 사전 계산 이관 대상(§2.2-4). */
export function measure<T>(route: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    const computeMs = performance.now() - started;
    const over = computeMs > CPU_WARN_MS;
    emit(over ? "warn" : "info", "cpu", { route, computeMs: Number(computeMs.toFixed(3)), overBudget: over });
  }
}

export async function measureAsync<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const elapsedMs = performance.now() - started;
    emit("info", "cpu", { route, elapsedMs: Number(elapsedMs.toFixed(3)), note: "includes I/O wait" });
  }
}

/** 외부 호출 1건 로깅 */
export function logFetch(source: string, url: string, status: number, ms: number, ok: boolean): void {
  emit(ok ? "info" : "warn", "upstream_fetch", {
    source, url: redact(url), status, ms: Number(ms.toFixed(1)), ok,
  });
}

/** 쿼리스트링의 키·토큰류를 가린다. */
export function redact(url: string): string {
  return url.replace(/([?&](?:key|token|appkey|appsecret|secret)=)[^&]*/gi, "$1***");
}

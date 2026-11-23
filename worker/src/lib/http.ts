import { log, logFetch } from "./logger.js";

/** 소스별 초당 호출 상한(§8.1-4). isolate 단위 토큰버킷 — 완벽한 전역 제한은 아니나
 *  Cron 단일 실행 경로에서 폭주를 막는 데 충분하다. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private readonly perSecond: number, private readonly burst = perSecond) {
    this.tokens = burst;
    this.last = Date.now();
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
      await sleep(Math.min(waitMs, 1000));
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UpstreamError extends Error {
  constructor(
    readonly source: string,
    readonly url: string,
    readonly status: number,
    readonly bodyHead: string,
    message?: string,
  ) {
    super(message ?? `${source} 호출 실패 (HTTP ${status})`);
    this.name = "UpstreamError";
  }
}

export type FetchOpts = {
  source: string;
  limiter?: RateLimiter;
  /** 지수 백오프 재시도 최대 횟수(§8.1-4) */
  retries?: number;
  timeoutMs?: number;
  init?: RequestInit;
};

/** 레이트 리미터 + 지수 백오프 재시도. 실패 시 UpstreamError 를 던진다(조용한 실패 금지, §8.1-5). */
export async function fetchText(url: string, opts: FetchOpts): Promise<string> {
  const { source, limiter, retries = 3, timeoutMs = 8000, init } = opts;
  let lastErr: UpstreamError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.take();
    const started = Date.now();
    try {
      const res = await withTimeout(fetch(url, init), timeoutMs);
      const ms = Date.now() - started;
      const body = await res.text();
      logFetch(source, url, res.status, ms, res.ok);
      if (!res.ok) {
        lastErr = new UpstreamError(source, url, res.status, body.slice(0, 300));
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;
      } else {
        return body;
      }
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof UpstreamError) { lastErr = e; if (attempt >= retries) break; }
      else {
        logFetch(source, url, 0, ms, false);
        lastErr = new UpstreamError(source, url, 0, String(e).slice(0, 300));
      }
    }
    if (attempt < retries) {
      const backoff = Math.min(4000, 300 * 2 ** attempt) + Math.floor(Math.random() * 200);
      log.warn("upstream_retry", { source, attempt: attempt + 1, backoffMs: backoff });
      await sleep(backoff);
    }
  }
  throw lastErr ?? new UpstreamError(source, url, 0, "", `${source} 호출 실패`);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

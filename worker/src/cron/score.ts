/**
 * F9 시그널 사후 채점 — 매 영업일 18:00 KST (`0 9 * * 1-5` UTC).
 * D+5 / D+20 / D+60 이 도래한 레코드의 실제 수익률·손절 선도달·목표 선도달을 기록한다.
 */

import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { listDue, SCORE_HORIZONS, scoreOne, writeScore, type ScoreHorizon } from "../analysis/signals.js";

export async function scoreSignals(env: Env, now = Date.now()): Promise<void> {
  let scored = 0;
  let pending = 0;
  for (const days of SCORE_HORIZONS as readonly ScoreHorizon[]) {
    const due = await listDue(env, days, now, 200);
    for (const s of due) {
      try {
        const result = await scoreOne(env, s, days, now);
        if (result === null) { pending++; continue; }   // 봉이 모자라면 다음 회차로 미룬다
        await writeScore(env, s.signal_id, days, result);
        scored++;
      } catch (e) {
        log.warn("score_failed", { signalId: s.signal_id, days, error: String(e).slice(0, 200) });
      }
    }
  }
  log.info("score_done", { scored, pending });
}

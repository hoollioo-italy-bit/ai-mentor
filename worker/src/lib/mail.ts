import type { Env } from "./env.js";
import { log } from "./logger.js";

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** mail_queue 에 PENDING 으로 적재. 실제 발송은 GAS 릴레이가 수행한다(§7). */
export async function enqueueMail(env: Env, to: string, subject: string, htmlBody: string): Promise<string | null> {
  if (!to) { log.warn("mail_skip_no_recipient", { subject }); return null; }
  const id = uid("mail");
  await env.DB.prepare(
    `INSERT INTO mail_queue (mail_id, to_addr, subject, html_body, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5)`,
  ).bind(id, to, subject, htmlBody, Date.now()).run();
  log.info("mail_enqueued", { mailId: id, subject });
  return id;
}

const ADMIN_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * §8.1-2 소스 변경 감지 알림.
 * 실패 URL · HTTP 상태 · 응답 본문 앞 300자를 포함한다.
 * 같은 소스에 대해 1시간 내 재통지는 억제한다(알림 폭주 방지).
 */
export async function notifySourceFailure(
  env: Env,
  source: string,
  detail: { url: string; status: number; bodyHead: string; reason: string },
): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT fail_streak, last_notified_at FROM source_health WHERE source = ?1`,
  ).bind(source).first<{ fail_streak: number; last_notified_at: number | null }>();

  const streak = (row?.fail_streak ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO source_health (source, last_fail_at, fail_streak, last_error)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(source) DO UPDATE SET last_fail_at = ?2, fail_streak = ?3, last_error = ?4`,
  ).bind(source, now, streak, JSON.stringify(detail)).run();

  const lastNotified = row?.last_notified_at ?? 0;
  if (now - lastNotified < ADMIN_NOTIFY_COOLDOWN_MS) return;

  const html = `
    <h3>외부 데이터 소스 이상 감지</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th align="left">소스</th><td>${esc(source)}</td></tr>
      <tr><th align="left">사유</th><td>${esc(detail.reason)}</td></tr>
      <tr><th align="left">연속 실패</th><td>${streak}회</td></tr>
      <tr><th align="left">URL</th><td>${esc(detail.url)}</td></tr>
      <tr><th align="left">HTTP</th><td>${detail.status}</td></tr>
      <tr><th align="left">응답 앞 300자</th><td><pre style="white-space:pre-wrap">${esc(detail.bodyHead.slice(0, 300))}</pre></td></tr>
      <tr><th align="left">시각</th><td>${new Date(now).toISOString()}</td></tr>
    </table>
    <p>스키마가 변경되었을 수 있습니다. <code>worker/src/providers/${esc(source)}.ts</code> 와
       <code>scripts/verify-provider.ts</code> 로 응답 구조를 재확인하십시오.</p>`;

  const mailId = await enqueueMail(env, env.ADMIN_EMAIL, `[주식앱] ${source} 소스 이상 (연속 ${streak}회)`, html);
  if (mailId) {
    await env.DB.prepare(`UPDATE source_health SET last_notified_at = ?2 WHERE source = ?1`)
      .bind(source, now).run();
  }
}

export async function recordSourceOk(env: Env, source: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO source_health (source, last_ok_at, fail_streak) VALUES (?1, ?2, 0)
     ON CONFLICT(source) DO UPDATE SET last_ok_at = ?2, fail_streak = 0`,
  ).bind(source, Date.now()).run();
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

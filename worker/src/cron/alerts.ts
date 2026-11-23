// F10 알림 — 장중 30분 간격. Cron 표현식(UTC): */30 0-6 * * 1-5
//   (블록 주석 안에 두면 주석이 조기 종료되므로 줄 주석으로 둔다)
//
// positions 의 stop_loss / target 도달 여부를 확인해 mail_queue 에 INSERT 한다.
// 중복 발송은 alerts.fired_at 플래그로 막는다.

import type { Env } from "../lib/env.js";
import { log } from "../lib/logger.js";
import { enqueueMail, esc, uid } from "../lib/mail.js";
import { getProvider } from "../providers/index.js";
import { readCandles } from "../providers/index.js";
import { loadMasterWithFallback } from "../providers/master.js";

type Row = {
  portfolio_id: string; user_id: string; code: string; qty: number;
  avg_price: number; stop_loss: number | null; target: number | null;
};

export async function checkAlerts(env: Env, now = Date.now()): Promise<void> {
  const rs = await env.DB.prepare(
    `SELECT p.portfolio_id, f.user_id, p.code, p.qty, p.avg_price, p.stop_loss, p.target
       FROM positions p JOIN portfolios f ON f.portfolio_id = p.portfolio_id
      WHERE p.qty > 0 AND (p.stop_loss IS NOT NULL OR p.target IS NOT NULL)
      LIMIT 200`,
  ).all<Row>();
  const rows = rs.results ?? [];
  if (rows.length === 0) return;

  const doc = await loadMasterWithFallback(env);
  const nameOf = new Map(doc.entries.map((e) => [e.code, e.name]));
  const provider = getProvider(env);
  let fired = 0;

  for (const r of rows) {
    const price = await currentPrice(env, provider, r.code, now);
    if (price === null) continue;

    for (const [kind, threshold] of [["STOP_LOSS", r.stop_loss], ["TARGET", r.target]] as const) {
      if (threshold === null) continue;
      const hit = kind === "STOP_LOSS" ? price <= threshold : price >= threshold;
      if (!hit) continue;

      const already = await env.DB.prepare(
        `SELECT alert_id FROM alerts WHERE user_id = ?1 AND code = ?2 AND kind = ?3 AND fired_at IS NOT NULL
          ORDER BY fired_at DESC LIMIT 1`,
      ).bind(r.user_id, r.code, kind).first<{ alert_id: string }>();
      if (already) continue;   // 중복 발송 방지

      const name = nameOf.get(r.code) ?? r.code;
      const pnl = (price - r.avg_price) * r.qty;
      const pnlRate = r.avg_price > 0 ? ((price - r.avg_price) / r.avg_price) * 100 : 0;
      const basis = await lastSignalBasis(env, r.code);

      const html = `
        <h3>${esc(name)}(${esc(r.code)}) ${kind === "STOP_LOSS" ? "손절가" : "목표가"} 도달</h3>
        <table border="1" cellpadding="6" cellspacing="0">
          <tr><th align="left">도달 유형</th><td>${kind === "STOP_LOSS" ? "손절가" : "목표가"} ${Math.round(threshold).toLocaleString("ko-KR")}원</td></tr>
          <tr><th align="left">현재가</th><td>${Math.round(price).toLocaleString("ko-KR")}원</td></tr>
          <tr><th align="left">진입가</th><td>${Math.round(r.avg_price).toLocaleString("ko-KR")}원</td></tr>
          <tr><th align="left">평가손익</th><td>${Math.round(pnl).toLocaleString("ko-KR")}원 (${pnlRate >= 0 ? "+" : ""}${pnlRate.toFixed(2)}%)</td></tr>
          <tr><th align="left">보유수량</th><td>${r.qty.toLocaleString("ko-KR")}주</td></tr>
          <tr><th align="left">원래 근거</th><td>${esc(basis)}</td></tr>
        </table>
        <p style="color:#64748b;font-size:12px">본 정보는 투자 판단 참고용이며 투자 권유가 아닙니다. 투자 결과의 책임은 이용자 본인에게 있습니다.</p>`;

      await enqueueMail(env, r.user_id, `[주식앱] ${name} ${kind === "STOP_LOSS" ? "손절가" : "목표가"} 도달`, html);
      await env.DB.prepare(
        `INSERT INTO alerts (alert_id, user_id, code, kind, threshold, fired_at) VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(uid("alt"), r.user_id, r.code, kind, threshold, now).run();
      fired++;
    }
  }
  log.info("alerts_checked", { positions: rows.length, fired });
}

async function currentPrice(env: Env, provider: ReturnType<typeof getProvider>, code: string, now: number): Promise<number | null> {
  try { return (await provider.getQuote(code)).price; }
  catch {
    const rows = await readCandles(env, code, "1m", now - 3 * 86_400_000, now, 1);
    if (rows.length > 0) return rows[rows.length - 1]!.c;
    const daily = await readCandles(env, code, "1d", now - 10 * 86_400_000, now, 1);
    return daily.length > 0 ? daily[daily.length - 1]!.c : null;
  }
}

/** 메일에 넣을 "해당 시그널의 원래 근거 요약" */
async function lastSignalBasis(env: Env, code: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT signal_type, entry, stop_loss, target, risk_reward, created_at
       FROM signals WHERE code = ?1 ORDER BY created_at DESC LIMIT 1`,
  ).bind(code).first<{ signal_type: string; entry: number | null; stop_loss: number | null; target: number | null; risk_reward: number | null; created_at: number }>();
  if (!row) return "연결된 시그널 없음 (직접 설정한 가격)";
  const d = new Date(row.created_at + 9 * 3600_000).toISOString().slice(0, 10);
  return `${d} ${row.signal_type} · 진입 ${fmt(row.entry)} / 손절 ${fmt(row.stop_loss)} / 목표 ${fmt(row.target)} · R:R ${row.risk_reward?.toFixed(2) ?? "-"}`;
}

const fmt = (n: number | null): string => (n === null ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);

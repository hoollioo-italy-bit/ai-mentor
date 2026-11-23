/**
 * §1.2 안전장치 — "경고 문구 표시"가 아니라 **기능 차단**으로 구현한다.
 * blocking=true 인 플래그가 하나라도 있으면 가이드(F6)를 생성하지 않는다.
 */

import {
  MIN_RR, MIN_SAMPLE, MIN_TRADING_VALUE, MAX_POSITION_WEIGHT, SAFETY_BADGE,
  type Freshness, type SafetyFlag, type HorizonConfig,
} from "@app/shared";

/** 거래 유의 지정 사유 — 하나라도 걸리면 S2 차단 */
export const BLOCKING_STATUS = ["관리종목", "거래정지", "투자경고", "투자위험", "정리매매", "상장폐지"];

export type SafetyInput = {
  freshness: Freshness;
  /** null = 상태 동기화가 1회도 성공하지 않음 → 확인 불가 */
  status: string[] | null;
  sample: number;
  avgTradingValue: number | null;
  riskReward: number | null;
  listedAt: string | null;
  config: HorizonConfig;
  now: number;
};

export function evaluateSafety(i: SafetyInput): SafetyFlag[] {
  const out: SafetyFlag[] = [];

  /* S1 — 데이터가 지연·폴백 상태면 가이드 생성 차단 */
  if (i.freshness.state !== "LIVE") {
    out.push({
      code: "S1", blocking: true, badge: SAFETY_BADGE.S1,
      reason: i.freshness.state === "FALLBACK"
        ? `1차 소스 실패로 폴백 소스(${i.freshness.source}) 사용 중`
        : `실시간 조회 실패로 저장된 캐시(${i.freshness.source}) 표시 중`,
    });
  } else if (i.freshness.delayMinutes !== null && i.freshness.delayMinutes > 20) {
    out.push({
      code: "S1", blocking: true, badge: SAFETY_BADGE.S1,
      reason: `최종 봉이 ${i.freshness.delayMinutes}분 전 — 장중 지연 상태`,
    });
  }

  /* S2 — 관리종목·거래정지·투자경고 */
  if (i.status === null) {
    out.push({
      code: "S2", blocking: true, badge: SAFETY_BADGE.S2,
      reason: "종목 상태(관리종목·거래정지·투자경고) 동기화가 완료되지 않아 확인할 수 없습니다. 확인 불가 상태에서는 차단합니다.",
    });
  } else {
    const hit = i.status.filter((s) => BLOCKING_STATUS.some((b) => s.includes(b)));
    if (hit.length > 0) {
      out.push({ code: "S2", blocking: true, badge: SAFETY_BADGE.S2, reason: `지정 사유: ${hit.join(", ")}` });
    }
  }

  /* S3 — 동일 signal_type 채점 표본 30건 미만이면 신뢰도 수치를 만들지 않는다 */
  if (i.sample < MIN_SAMPLE) {
    out.push({
      code: "S3", blocking: false, badge: SAFETY_BADGE.S3,
      reason: `채점 표본 ${i.sample}건 (최소 ${MIN_SAMPLE}건). 적중률 수치를 산출하지 않습니다.`,
    });
  }

  /* S4 — 일평균 거래대금 30억 미만: 슬리피지 경고 + 유동성 부족 배지 */
  if (i.avgTradingValue !== null && i.avgTradingValue < MIN_TRADING_VALUE) {
    out.push({
      code: "S4", blocking: false, badge: SAFETY_BADGE.S4,
      reason: `일평균 거래대금 ${Math.round(i.avgTradingValue / 1e8).toLocaleString("ko-KR")}억원 — 체결 슬리피지가 커질 수 있습니다.`,
    });
  }

  /* S5 — 손익비 1.5 미만이면 가이드 미표시 */
  if (i.riskReward !== null && i.riskReward < MIN_RR) {
    out.push({
      code: "S5", blocking: true, badge: SAFETY_BADGE.S5,
      reason: `손익비 ${i.riskReward.toFixed(2)} < ${MIN_RR}`,
    });
  }

  /* S6 — 상장 1년 미만: 장기 지표(120/200) 미산출 + 해당 기간 선택 차단 */
  const young = isYoung(i.listedAt, i.now);
  if (young) {
    out.push({
      code: "S6", blocking: i.config.requiresLongHistory, badge: SAFETY_BADGE.S6,
      reason: i.config.requiresLongHistory
        ? `상장 1년 미만(${i.listedAt}) — ${i.config.label} 기간은 장기 지표가 필요해 선택할 수 없습니다.`
        : `상장 1년 미만(${i.listedAt}) — 120/200일 이평은 산출하지 않습니다.`,
    });
  }

  return out;
}

export function isYoung(listedAt: string | null, now: number): boolean {
  if (!listedAt) return false;
  const ms = Date.parse(`${listedAt}T00:00:00+09:00`);
  if (!Number.isFinite(ms)) return false;
  return now - ms < 365 * 86_400_000;
}

export const isBlocked = (flags: SafetyFlag[]): boolean => flags.some((f) => f.blocking);

/** S7 — 단일 종목 비중이 포트폴리오 20% 초과. 모의투자 입력 시 경고(차단 아님). */
export function checkConcentration(positionValue: number, totalValue: number): SafetyFlag | null {
  if (totalValue <= 0) return null;
  const w = positionValue / totalValue;
  if (w <= MAX_POSITION_WEIGHT) return null;
  return {
    code: "S7", blocking: false, badge: SAFETY_BADGE.S7,
    reason: `이 매매 후 단일 종목 비중 ${(w * 100).toFixed(1)}% — 권장 상한 ${MAX_POSITION_WEIGHT * 100}% 초과`,
  };
}

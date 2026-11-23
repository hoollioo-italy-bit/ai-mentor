/** 모든 시장 시각 계산은 Asia/Seoul. 저장은 epoch ms. Cron 표현식은 UTC(§8.2). */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MS_DAY = 86_400_000;

export type KstParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number };

export function kstParts(ms: number): KstParts {
  const d = new Date(ms + KST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    dow: d.getUTCDay(),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" (KST) */
export function kstDate(ms: number): string {
  const p = kstParts(ms);
  return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
}

/** "YYYYMMDD" (KST) — analysis_cache key 등에 사용 */
export function kstYmd(ms: number): string {
  const p = kstParts(ms);
  return `${p.y}${p2(p.m)}${p2(p.d)}`;
}

/** KST 기준 해당 일자 00:00 의 epoch ms */
export function kstMidnight(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / MS_DAY) * MS_DAY - KST_OFFSET_MS;
}

/** "YYYY-MM-DD" (KST 자정) → epoch ms */
export function fromKstDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1) - KST_OFFSET_MS;
}

/** 토·일 제외. 공휴일은 캘린더 소스가 없으므로 판정하지 않는다(거래 데이터 유무로 대체). */
export function isWeekendKst(ms: number): boolean {
  const dow = kstParts(ms).dow;
  return dow === 0 || dow === 6;
}

/** 정규장 09:00~15:30 KST */
export function isRegularSession(ms: number): boolean {
  if (isWeekendKst(ms)) return false;
  const { hh, mm } = kstParts(ms);
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

/** 분봉 VWAP 세션 리셋 키 */
export function sessionKeyOf(ms: number): string {
  return kstDate(ms);
}

/** 장 마감 이후인지(15:30 KST 초과) */
export function isAfterClose(ms: number): boolean {
  const { hh, mm } = kstParts(ms);
  return hh * 60 + mm > 15 * 60 + 30;
}

/**
 * 장중 기준 데이터 지연(분). 장외 시간에는 지연 개념이 성립하지 않으므로 null.
 * lastBarAt 이 없으면 null.
 */
export function delayMinutes(now: number, lastBarAt: number | null): number | null {
  if (lastBarAt === null) return null;
  if (!isRegularSession(now)) return null;
  return Math.max(0, Math.round((now - lastBarAt) / 60_000));
}

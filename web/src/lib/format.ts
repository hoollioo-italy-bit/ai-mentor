export const won = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`;

export const num = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : n.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const pct = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;

export const pctRaw = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

export const eok = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n / 1e8).toLocaleString("ko-KR")}억원`;

export const kstDateTime = (ms: number): string =>
  new Date(ms + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);

export const kstDate = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** 등락 색상 — 색상만으로 전달하지 않도록 호출부에서 부호 텍스트를 병기한다. */
export const signColor = (n: number | null | undefined): string =>
  n === null || n === undefined || n === 0 ? "text-slate-600" : n > 0 ? "text-red-600" : "text-blue-600";

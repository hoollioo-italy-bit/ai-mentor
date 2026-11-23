import type { SafetyFlag } from "@app/shared";
import { DISCLAIMER } from "@app/shared";

/** §1.1 — 모든 분석 화면 하단에 고정 노출 */
export function Disclaimer() {
  return (
    <p className="mt-6 rounded-lg bg-slate-100 px-4 py-3 text-xs leading-relaxed text-slate-600">
      {DISCLAIMER}
    </p>
  );
}

/** 접근성: 색상만으로 정보를 전달하지 않도록 배지에 항상 라벨 텍스트를 병기한다(§8.2). */
export function Badge({ tone, children, title }: { tone: "danger" | "warn" | "info" | "ok"; children: React.ReactNode; title?: string }) {
  const cls = {
    danger: "border-red-300 bg-red-50 text-red-800",
    warn: "border-amber-300 bg-amber-50 text-amber-800",
    info: "border-slate-300 bg-slate-50 text-slate-700",
    ok: "border-emerald-300 bg-emerald-50 text-emerald-800",
  }[tone];
  return <span className={`chip ${cls}`} title={title}>{children}</span>;
}

export function SafetyBadges({ flags }: { flags: SafetyFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {flags.map((f, i) => (
        <Badge key={`${f.code}-${i}`} tone={f.blocking ? "danger" : "warn"} title={f.reason}>
          <span className="font-mono text-[10px] opacity-70">{f.code}</span>
          {f.badge}
          {f.blocking && <span className="ml-1 rounded bg-red-600 px-1 text-[10px] text-white">차단</span>}
        </Badge>
      ))}
    </div>
  );
}

export function SafetyDetail({ flags }: { flags: SafetyFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-slate-600">
      {flags.map((f, i) => (
        <li key={`${f.code}-${i}`} className="flex gap-2">
          <span className={`mt-[2px] h-fit shrink-0 rounded px-1 font-mono text-[10px] ${f.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            {f.code}
          </span>
          <span>{f.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** §1.2 검증 현황 배지 — 표본이 적을수록 과신하지 않도록 전면 배치 */
export function VerificationBadge({ scored, hitRate }: { scored: number; hitRate: number | null }) {
  return (
    <Badge tone={hitRate === null ? "warn" : "info"}
           title="가이드 자체의 사후 채점 결과입니다. 모의투자 성과와는 별개입니다.">
      검증 {scored.toLocaleString("ko-KR")}건
      {hitRate === null ? " · 적중률 산출 전(표본 부족)" : ` · 적중률 ${(hitRate * 100).toFixed(1)}%`}
    </Badge>
  );
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card card-pad">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Spinner({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p>{message}</p>
      {onRetry && <button className="btn-ghost mt-2" onClick={onRetry}>다시 시도</button>}
    </div>
  );
}

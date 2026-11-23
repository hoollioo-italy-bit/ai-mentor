import type { AnalysisPayload } from "@app/shared";
import { SIGNAL_TYPE_LABEL } from "@app/shared";
import { Badge, SafetyBadges, SafetyDetail, Section } from "./Common";
import { num, won } from "../lib/format";

/**
 * F6 투자 가이드 (3점 세트).
 * §1.1 — 가격 수준과 조건만 제시하며 행동 지시 문구를 쓰지 않는다.
 * §1.2 — 차단 플래그가 있으면 가이드 자체를 렌더링하지 않는다.
 */
export function GuidePanel({ p, onSaveSignal, saving }: {
  p: AnalysisPayload; onSaveSignal?: () => void; saving?: boolean;
}) {
  const g = p.guide;
  const blocking = p.safety.filter((f) => f.blocking);

  return (
    <Section
      title="투자 가이드"
      right={<Badge tone="info">{SIGNAL_TYPE_LABEL[g.signalType] ?? g.signalType}</Badge>}
    >
      <SafetyBadges flags={p.safety} />

      {!g.available ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-900">
            {g.message ?? "가이드를 생성하지 않습니다."}
          </p>
          <SafetyDetail flags={blocking.length ? blocking : p.safety} />
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Level tone="info" title="진입 구간"
                   main={`${won(g.entry!.low)} ~ ${won(g.entry!.high)}`} sub={g.entry!.basis} />
            <Level tone="danger" title="손절가" main={won(g.stopLoss!.price)} sub={g.stopLoss!.basis} />
            <Level tone="ok" title="목표가" main={won(g.target!.price)} sub={g.target!.basis} />
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Cell label="손익비 (R:R)" value={g.riskReward?.toFixed(2) ?? "-"} />
            <Cell label="권장 비중" value={g.suggestedWeightPct === null ? "-" : `${num(g.suggestedWeightPct, 1)}%`}
                  note="계좌 대비 최대손실 2% 기준 역산" />
            <Cell label="최대손실액" value={won(g.maxLossAmount)} note="손절 도달 시" />
            <Cell
              label="신뢰도"
              value={g.confidence.available ? `${(g.confidence.hitRate * 100).toFixed(1)}%` : "표본 부족"}
              note={g.confidence.available
                ? `동일 시그널 ${g.confidence.sample}건 · D+${g.confidence.horizonDays} 기준`
                : g.confidence.reason}
              warn={!g.confidence.available}
            />
          </dl>

          {onSaveSignal && (
            <div className="mt-3 flex items-center gap-2">
              <button className="btn-primary" onClick={onSaveSignal} disabled={saving}>
                {saving ? "저장 중…" : "이 시그널 기록 (사후 채점 대상)"}
              </button>
              <span className="text-xs text-slate-500">기록해야 D+5/20/60 적중률 검증에 포함됩니다.</span>
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        표시된 가격은 지표에서 산출한 수준이며 매매 지시가 아닙니다. 무효화 조건은 해석 패널을 확인하십시오.
      </p>
    </Section>
  );
}

function Level({ tone, title, main, sub }: { tone: "info" | "danger" | "ok"; title: string; main: string; sub: string }) {
  const cls = { info: "border-slate-300", danger: "border-red-300", ok: "border-emerald-300" }[tone];
  return (
    <div className={`rounded-lg border-2 ${cls} p-3`}>
      <p className="label">{title}</p>
      <p className="num text-base font-semibold text-slate-900">{main}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function Cell({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1.5 ${warn ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
      <dt className="label">{label}</dt>
      <dd className="num text-sm font-medium text-slate-900">{value}</dd>
      {note && <dd className="mt-0.5 text-[11px] leading-tight text-slate-500">{note}</dd>}
    </div>
  );
}

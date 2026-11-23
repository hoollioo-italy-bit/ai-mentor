import type { AnalysisPayload } from "@app/shared";
import { Badge, Section } from "./Common";
import { eok, pctRaw, won } from "../lib/format";

const TREND_KO = { UP: "상승", SIDEWAYS: "횡보", DOWN: "하락" } as const;

/** F5 분석 해석 패널 — 규칙 기반 템플릿 문장만 표시한다. */
export function AnalysisPanel({ p }: { p: AnalysisPayload }) {
  const i = p.interpretation;
  const rows = [
    { title: "1. 추세 판정", state: TREND_KO[i.trend.state], text: i.trend.text, ev: i.trend.evidence },
    { title: "2. 모멘텀", state: null, text: i.momentum.text, ev: i.momentum.evidence },
    { title: "3. 변동성", state: null, text: i.volatility.text, ev: i.volatility.evidence },
    { title: "4. 수급", state: null, text: i.flow.text, ev: i.flow.evidence },
  ];

  return (
    <Section title="분석 해석">
      {i.timeframeConflict.conflict && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {i.timeframeConflict.text}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.title} className="rounded-lg border border-slate-200 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-slate-900">
              {r.title}
              {r.state && <Badge tone="info">{r.state}</Badge>}
            </p>
            <p className="mt-1 text-sm text-slate-700">{r.text}</p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-slate-500">
              {r.ev.map((e, k) => <li key={k}>· {e}</li>)}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 p-3">
        <p className="text-xs font-semibold text-slate-900">5. 시장 국면</p>
        <p className="mt-1 text-sm text-slate-700">{p.regime.text}</p>
        <ul className="mt-1.5 space-y-0.5 text-xs text-slate-500">
          <li>· 코스피 {TREND_KO[p.regime.kospi.trend]} · 종가 {won(p.regime.kospi.close)} ({pctRaw(p.regime.kospi.changeRate)})</li>
          <li>· 코스닥 {TREND_KO[p.regime.kosdaq.trend]} · 종가 {won(p.regime.kosdaq.close)} ({pctRaw(p.regime.kosdaq.changeRate)})</li>
          <li>· 상대강도 산출 기간 {p.regime.rsWindowDays}일</li>
        </ul>
      </div>

      {/* §1.1 허용 형식 — ①현재 상태 ②조건부 시나리오 ③무효화 조건 */}
      <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
        <p className="text-xs font-semibold text-slate-900">6. 종합 서술</p>
        <div>
          <p className="label">① 현재 상태</p>
          <p className="text-sm text-slate-800">{i.composite.state}</p>
        </div>
        <div>
          <p className="label">② 조건부 시나리오</p>
          <ul className="space-y-1 text-sm text-slate-800">
            {i.composite.scenarios.map((s, k) => <li key={k}>· {s}</li>)}
          </ul>
        </div>
        <div>
          <p className="label">③ 무효화 조건</p>
          <p className="text-sm font-medium text-slate-900">{i.composite.invalidation}</p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Stat label="RSI(14)" value={p.snapshot.rsi14?.toFixed(1) ?? "-"} />
        <Stat label="ATR(14)" value={won(p.snapshot.atr14)} />
        <Stat label="밴드폭" value={p.snapshot.bollinger.bandwidth === null ? "-" : `${(p.snapshot.bollinger.bandwidth * 100).toFixed(2)}%`} />
        <Stat label="20일 평균 거래대금" value={eok(p.snapshot.avgTradingValue20)} />
      </dl>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5">
      <dt className="label">{label}</dt>
      <dd className="num text-sm text-slate-900">{value}</dd>
    </div>
  );
}

/** F4 주석 목록 — 차트 위 도형과 1:1 대응하는 한 줄 해석 라벨 */
export function AnnotationList({ p }: { p: AnalysisPayload }) {
  if (p.annotations.length === 0) return null;
  const color: Record<string, string> = {
    SUPPORT: "#2563EB", RESISTANCE: "#DC2626", TRENDLINE: "#6B7280", CHANNEL: "#6B7280",
    FIBONACCI: "#6B7280", MA_CROSS: "#EA580C", BB_SQUEEZE: "#6B7280", VOLUME_SPIKE: "#EA580C", EVENT: "#7C3AED",
  };
  return (
    <Section title={`차트 주석 (${p.annotations.length}건)`}>
      <ul className="space-y-1.5">
        {p.annotations.slice(0, 40).map((a, k) => (
          <li key={k} className="flex items-start gap-2 text-xs">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: color[a.kind] ?? "#94a3b8" }} aria-hidden />
            <span className="min-w-0">
              <b className="text-slate-800">{a.label}</b>
              <span className="text-slate-500"> — {a.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

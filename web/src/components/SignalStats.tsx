import { useEffect, useState } from "react";
import { MIN_SAMPLE, type SignalStat } from "@app/shared";
import { api } from "../lib/api";
import { Badge, ErrorBox, Section, Spinner } from "./Common";
import { pct } from "../lib/format";

/**
 * F9 시그널 적중률 집계.
 * ★ 모의투자 성과(F8)와 **분리 표시**한다 — 모의투자에는 사용자 판단이 섞여 있어
 *   가이드 자체의 성능을 측정할 수 없기 때문이다.
 */
export function SignalStats() {
  const [days, setDays] = useState(20);
  const [data, setData] = useState<{ stats: SignalStat[]; verification: { scored: number; hitRate: number | null }; pendingScoring: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.signalStats(days)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [days]);

  return (
    <Section
      title="시그널 적중률 (가이드 자체 성능)"
      right={
        <div className="flex gap-1.5">
          {[5, 20, 60].map((d) => (
            <button key={d} onClick={() => setDays(d)}
                    className={`chip ${days === d ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-600"}`}>
              D+{d}
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-3 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
        이 표는 <b>가이드가 제시한 수준</b>의 사후 검증 결과입니다. 사용자 판단이 섞인 모의투자 성과와는 별개로 읽으십시오.
      </p>

      {error && <ErrorBox message={error} />}
      {!data && !error && <Spinner />}

      {data && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge tone="info">전체 채점 {data.verification.scored.toLocaleString("ko-KR")}건</Badge>
            <Badge tone={data.verification.hitRate === null ? "warn" : "info"}>
              전체 적중률 {data.verification.hitRate === null ? "산출 전(표본 부족)" : `${(data.verification.hitRate * 100).toFixed(1)}%`}
            </Badge>
            <Badge tone="warn">채점 대기 {data.pendingScoring.toLocaleString("ko-KR")}건</Badge>
          </div>

          {data.stats.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              아직 채점된 시그널이 없습니다. 가이드가 생성되면 자동 기록되고, 매 영업일 18시에 채점됩니다.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-2 font-medium">시그널 유형</th>
                    <th className="py-2 pr-2 text-right font-medium">표본</th>
                    <th className="py-2 pr-2 text-right font-medium">적중률</th>
                    <th className="py-2 pr-2 text-right font-medium">평균수익률</th>
                    <th className="py-2 text-right font-medium">손절 도달률</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stats.map((s) => (
                    <tr key={s.signalType} className="border-b border-slate-100">
                      <td className="py-2 pr-2">{s.label}</td>
                      <td className="num py-2 pr-2 text-right">{s.sample.toLocaleString("ko-KR")}</td>
                      <td className="num py-2 pr-2 text-right">
                        {s.insufficient
                          ? <span className="text-amber-700">표본 부족 ({s.sample}/{MIN_SAMPLE})</span>
                          : `${(s.hitRate! * 100).toFixed(1)}%`}
                      </td>
                      <td className="num py-2 pr-2 text-right">{s.insufficient ? "-" : pct(s.avgReturn)}</td>
                      <td className="num py-2 text-right">{s.insufficient ? "-" : `${(s.stopRate! * 100).toFixed(1)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

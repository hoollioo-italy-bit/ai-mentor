import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnalysisPayload, Horizon } from "@app/shared";
import { HORIZONS, HORIZON_CONFIG } from "@app/shared";
import { api, ApiError, type PortfolioDetail } from "./lib/api";
import { Chart, DEFAULT_TOGGLES, type Toggles } from "./components/Chart";
import { AnnotationToggles, HorizonTabs, intervalLabel } from "./components/HorizonTabs";
import { AnalysisPanel, AnnotationList } from "./components/AnalysisPanel";
import { GuidePanel } from "./components/GuidePanel";
import { SymbolSearch } from "./components/SymbolSearch";
import { SignalStats } from "./components/SignalStats";
import { SimTrade } from "./components/SimTrade";
import { PerformancePanel } from "./components/PerformancePanel";
import { PortfolioPicker } from "./components/PortfolioPicker";
import { ComparePanel, EventsEditor, ExportButton, WatchlistPanel } from "./components/Extras";
import { Badge, Disclaimer, ErrorBox, Section, Spinner, VerificationBadge } from "./components/Common";
import { kstDateTime, pctRaw, won } from "./lib/format";

const TREND_KO = { UP: "상승", SIDEWAYS: "횡보", DOWN: "하락" } as const;

export default function App() {
  const [selected, setSelected] = useState<{ code: string; name: string } | null>(null);
  const [horizon, setHorizon] = useState<Horizon>("1m");
  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Toggles>(DEFAULT_TOGGLES);
  const [showHigher, setShowHigher] = useState(true);
  const [portfolio, setPortfolio] = useState<PortfolioDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [savingSignal, setSavingSignal] = useState(false);
  const [regime, setRegime] = useState<{ kospi: { trend: string }; kosdaq: { trend: string } } | null>(null);
  const [blocked, setBlocked] = useState<Set<Horizon>>(new Set());

  useEffect(() => { api.regime().then(setRegime).catch(() => undefined); }, []);

  const load = useCallback(async (code: string, h: Horizon, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.analysis(code, h, 10_000_000, refresh);
      setPayload(p);
      setBlocked((prev) => { const n = new Set(prev); n.delete(h); return n; });
    } catch (e) {
      const ae = e as ApiError;
      setPayload(null);
      setError(ae.message);
      if (ae.code === "BLOCKED_BY_SAFETY") setBlocked((prev) => new Set(prev).add(h));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!selected) return;
    void load(selected.code, horizon);
  }, [selected, horizon, load]);

  const pick = (code: string, name: string) => {
    setBlocked(new Set());
    setSelected({ code, name });
    setRefreshKey((k) => k + 1);
  };

  const higherBlockedHorizons = useMemo(() => blocked, [blocked]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900">국내 주식 차트분석 · 모의투자</h1>
          <p className="text-xs text-slate-500">지표 상태를 해석하고, 그 해석이 맞았는지 사후 검증하는 판단 보조 도구</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {regime && (
            <Badge tone="info">
              코스피 {TREND_KO[regime.kospi.trend as keyof typeof TREND_KO] ?? regime.kospi.trend} ·
              코스닥 {TREND_KO[regime.kosdaq.trend as keyof typeof TREND_KO] ?? regime.kosdaq.trend}
            </Badge>
          )}
          {payload && <VerificationBadge scored={payload.verification.scored} hitRate={payload.verification.hitRate} />}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Section title="종목 검색"><SymbolSearch onSelect={pick} /></Section>
          <WatchlistPanel onSelect={pick} refreshKey={refreshKey} />
          <PortfolioPicker value={portfolio} onChange={setPortfolio} refreshKey={refreshKey} />
        </aside>

        <main className="min-w-0 space-y-5">
          {!selected && (
            <Section title="시작하기">
              <p className="py-8 text-center text-sm text-slate-500">
                왼쪽에서 종목을 검색해 선택하십시오.
              </p>
            </Section>
          )}

          {selected && (
            <>
              <Section
                title={`${selected.name} (${selected.code})`}
                right={
                  <div className="flex items-center gap-2">
                    {payload && (
                      <>
                        <button className="btn-ghost text-xs" onClick={() => api.addWatch(selected.code).then(() => setRefreshKey((k) => k + 1))}>
                          관심종목 추가
                        </button>
                        <button className="btn-ghost text-xs" onClick={() => load(selected.code, horizon, true)}>새로고침</button>
                        <ExportButton targetId="report-area" filename={`${selected.code}_${horizon}`} />
                      </>
                    )}
                  </div>
                }
              >
                <HorizonTabs value={horizon} onChange={setHorizon} blocked={higherBlockedHorizons} />
              </Section>

              {loading && <Section title="분석"><Spinner label="지표·주석 산출 중" /></Section>}
              {error && !loading && <Section title="분석"><ErrorBox message={error} onRetry={() => load(selected.code, horizon, true)} /></Section>}

              {payload && !loading && (
                <div id="report-area" className="space-y-5">
                  <Section
                    title={`주 차트 — ${intervalLabel(payload.primary.interval)}`}
                    right={
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={payload.freshness.state === "LIVE" ? "ok" : "danger"}>
                          {payload.freshness.state === "LIVE" ? "실시간 조회" : "데이터 지연 — 판단 근거로 사용 불가"}
                          <span className="ml-1 text-[10px] opacity-70">{payload.freshness.source}</span>
                        </Badge>
                        <span className="num text-xs text-slate-500">
                          종가 {won(payload.snapshot.close)} · {kstDateTime(payload.computedAt)}
                        </span>
                      </div>
                    }
                  >
                    <Chart
                      candles={payload.primary.candles}
                      indicators={payload.primary.indicators}
                      annotations={payload.annotations}
                      interval={payload.primary.interval}
                      toggles={toggles}
                      height={440}
                    />
                    <div className="mt-3"><AnnotationToggles value={toggles} onChange={setToggles} /></div>
                  </Section>

                  <Section
                    title={`상위 확인 차트 — ${payload.higher.label}`}
                    right={
                      <div className="flex items-center gap-2">
                        <Badge tone={payload.interpretation.timeframeConflict.conflict ? "danger" : "info"}>
                          상위 추세 {TREND_KO[payload.higher.trend]}
                        </Badge>
                        <button className="btn-ghost text-xs" onClick={() => setShowHigher((v) => !v)}>
                          {showHigher ? "접기" : "펼치기"}
                        </button>
                      </div>
                    }
                  >
                    {payload.interpretation.timeframeConflict.conflict && (
                      <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        {payload.interpretation.timeframeConflict.text}
                      </p>
                    )}
                    {showHigher && (
                      <Chart
                        candles={payload.higher.candles}
                        indicators={payload.higher.indicators}
                        annotations={[]}
                        interval={payload.higher.interval}
                        toggles={{ ...toggles, sr: false, fib: false, channel: false }}
                        height={200}
                        compact
                      />
                    )}
                  </Section>

                  <AnalysisPanel p={payload} />
                  <AnnotationList p={payload} />
                  <GuidePanel
                    p={payload}
                    saving={savingSignal}
                    onSaveSignal={payload.guide.available ? async () => {
                      setSavingSignal(true);
                      try { await api.saveSignal(selected.code, horizon); }
                      finally { setSavingSignal(false); }
                    } : undefined}
                  />
                  <SimTrade p={payload} portfolio={portfolio} onTraded={() => setRefreshKey((k) => k + 1)} />
                  <PerformancePanel portfolio={portfolio} />
                  <ComparePanel baseCode={selected.code} />
                  <EventsEditor code={selected.code} onChanged={() => load(selected.code, horizon, true)} />
                </div>
              )}
            </>
          )}

          <SignalStats />
          <Disclaimer />
        </main>
      </div>
    </div>
  );
}

export { HORIZONS, HORIZON_CONFIG, pctRaw };

import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import type { Performance } from "@app/shared";
import { api, type PortfolioDetail } from "../lib/api";
import { Badge, ErrorBox, Section, Spinner } from "./Common";
import { pct, signColor, won } from "../lib/format";

/** F8 성과 + 벤치마크 병기(정규화 시작=100) */
export function PerformancePanel({ portfolio }: { portfolio: PortfolioDetail | null }) {
  const [perf, setPerf] = useState<Performance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = portfolio?.portfolio.portfolioId;

  useEffect(() => {
    if (!id) { setPerf(null); return; }
    let alive = true;
    setPerf(null);
    api.performance(id)
      .then((d) => { if (alive) setPerf(d); })
      .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [id]);

  if (!portfolio) return null;

  return (
    <Section title="모의투자 성과">
      <p className="mb-3 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
        이 성과에는 <b>사용자의 매매 판단</b>이 섞여 있습니다. 가이드 자체의 성능은 아래 「시그널 적중률」에서 별도로 확인하십시오.
      </p>
      {error && <ErrorBox message={error} />}
      {!perf && !error && <Spinner />}
      {perf && (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Cell label="총평가금액" value={won(perf.totalValue)} />
            <Cell label="누적수익률" value={pct(perf.cumulativeReturn)} tone={perf.cumulativeReturn} />
            <Cell label="실현손익" value={won(perf.realizedPnl)} tone={perf.realizedPnl} />
            <Cell label="미실현손익" value={won(perf.unrealizedPnl)} tone={perf.unrealizedPnl} />
            <Cell label="MDD" value={pct(perf.mdd)} tone={perf.mdd} />
            <Cell label="승률" value={perf.winRate === null ? "청산 없음" : `${(perf.winRate * 100).toFixed(1)}%`} />
            <Cell label="평균 손익비" value={perf.avgWinLossRatio?.toFixed(2) ?? "-"} />
            <Cell label="거래 건수" value={`${perf.tradeCount}건 (청산 ${perf.closedCount})`} />
          </dl>

          <p className={`mt-3 rounded-lg border px-3 py-2 text-sm font-medium ${
            perf.verdict.includes("훼손") ? "border-red-300 bg-red-50 text-red-900" : "border-emerald-300 bg-emerald-50 text-emerald-900"}`}>
            {perf.verdict}
          </p>

          <BenchmarkChart perf={perf} />

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge tone="info"><span className="mr-1 inline-block h-2 w-3 bg-slate-900" aria-hidden />내 포트폴리오</Badge>
            <Badge tone="info"><span className="mr-1 inline-block h-2 w-3 bg-sky-500" aria-hidden />{perf.benchmark.indexName}</Badge>
            <Badge tone="info"><span className="mr-1 inline-block h-2 w-3 bg-amber-500" aria-hidden />{perf.benchmark.buyAndHoldName}</Badge>
          </div>
        </>
      )}
    </Section>
  );
}

function BenchmarkChart({ perf }: { perf: Performance }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || perf.benchmark.dates.length === 0) return;
    const chart = createChart(el, {
      height: 240,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#334155", fontSize: 11 },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#e2e8f0" },
      timeScale: { borderColor: "#e2e8f0" },
      localization: { locale: "ko-KR" },
    });
    const t = perf.benchmark.dates.map((d) => (((d / 1000) | 0) + 9 * 3600) as UTCTimestamp);
    const add = (values: number[], color: string, title: string) => {
      const s = chart.addLineSeries({ color, lineWidth: 2, title, priceLineVisible: false });
      s.setData(t.map((time, i) => ({ time, value: values[i] ?? 100 })));
    };
    add(perf.benchmark.portfolio, "#0f172a", "포트폴리오");
    add(perf.benchmark.index, "#0ea5e9", perf.benchmark.indexName);
    add(perf.benchmark.buyAndHold, "#f59e0b", "Buy&Hold");
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    return () => { ro.disconnect(); chart.remove(); };
  }, [perf]);
  return <div className="chart-scroll mt-3"><div ref={ref} className="min-w-[360px]" /></div>;
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5">
      <dt className="label">{label}</dt>
      <dd className={`num text-sm font-medium ${tone === undefined ? "text-slate-900" : signColor(tone)}`}>{value}</dd>
    </div>
  );
}

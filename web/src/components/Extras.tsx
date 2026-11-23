import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import type { MarketEvent, MarketEventKind } from "@app/shared";
import { EVENT_LABEL } from "@app/shared";
import { api, type PortfolioDetail, type WatchItem } from "../lib/api";
import { Badge, ErrorBox, Section, Spinner } from "./Common";
import { pctRaw, signColor, won } from "../lib/format";

/* ───────────── F11 관심종목 ───────────── */

export function WatchlistPanel({ onSelect, refreshKey }: { onSelect: (code: string, name: string) => void; refreshKey: number }) {
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.watchlist().then((d) => setItems(d.items)).catch((e) => setError(String(e.message ?? e)));
  };
  useEffect(load, [refreshKey]);

  return (
    <Section title="관심종목">
      {error && <ErrorBox message={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      {items && items.length === 0 && <p className="py-4 text-sm text-slate-500">등록된 관심종목이 없습니다.</p>}
      {items && items.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {items.map((w) => (
            <li key={w.code} className="flex items-center justify-between gap-2 py-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(w.code, w.name)}>
                <span className="block truncate text-sm font-medium text-slate-900">{w.name}</span>
                <span className="flex items-center gap-1.5">
                  <span className="num text-xs text-slate-500">{w.code}</span>
                  {w.status?.map((s) => <Badge key={s} tone="danger">{s}</Badge>)}
                  {w.lastSignal && <Badge tone="info">{w.lastSignal.signalType}</Badge>}
                </span>
              </button>
              <span className="shrink-0 text-right">
                <span className="num block text-sm">{won(w.price)}</span>
                <span className={`num block text-xs ${signColor(w.changeRate)}`}>
                  {w.changeRate === null ? "-" : pctRaw(w.changeRate)}
                </span>
              </span>
              <button className="btn-ghost px-2 py-1 text-xs"
                      onClick={async () => { await api.removeWatch(w.code); load(); }}>해제</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ───────────── F11 종목 비교 (2~3종목 정규화 수익률 중첩) ───────────── */

export function ComparePanel({ baseCode }: { baseCode: string }) {
  const [codes, setCodes] = useState<string[]>([baseCode]);
  const [input, setInput] = useState("");
  const [series, setSeries] = useState<{ code: string; t: number[]; v: number[] }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setCodes((c) => (c[0] === baseCode ? c : [baseCode, ...c.filter((x) => x !== baseCode)].slice(0, 3))); }, [baseCode]);

  useEffect(() => {
    let alive = true;
    Promise.all(codes.map((code) => api.candles(code, "1d").then((d) => ({ code, candles: d.candles }))))
      .then((rows) => {
        if (!alive) return;
        setSeries(rows.map((r) => {
          const base = r.candles[0]?.c ?? 0;
          return { code: r.code, t: r.candles.map((c) => c.t), v: r.candles.map((c) => (base > 0 ? (c.c / base) * 100 : 100)) };
        }));
        setError(null);
      })
      .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [codes]);

  useEffect(() => {
    const el = ref.current;
    if (!el || series.length === 0) return;
    const chart = createChart(el, {
      height: 240,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#334155", fontSize: 11 },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#e2e8f0" }, timeScale: { borderColor: "#e2e8f0" },
    });
    const palette = ["#0f172a", "#0ea5e9", "#f59e0b"];
    series.forEach((s, i) => {
      const ls = chart.addLineSeries({ color: palette[i] ?? "#94a3b8", lineWidth: 2, title: s.code, priceLineVisible: false });
      ls.setData(s.t.map((t, k) => ({ time: (((t / 1000) | 0) + 9 * 3600) as UTCTimestamp, value: s.v[k] ?? 100 })));
    });
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    return () => { ro.disconnect(); chart.remove(); };
  }, [series]);

  return (
    <Section title="종목 비교 (시작=100 정규화)">
      <div className="flex flex-wrap items-center gap-2">
        {codes.map((c) => (
          <Badge key={c} tone="info">
            {c}
            {c !== baseCode && (
              <button className="ml-1 text-slate-400 hover:text-slate-700"
                      onClick={() => setCodes(codes.filter((x) => x !== c))} aria-label={`${c} 제거`}>×</button>
            )}
          </Badge>
        ))}
        {codes.length < 3 && (
          <span className="flex gap-1">
            <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="종목코드"
                   className="num w-28 rounded border border-slate-300 px-2 py-1 text-xs" />
            <button className="btn-ghost px-2 py-1 text-xs"
                    onClick={() => { if (/^[0-9A-Z]{6}$/.test(input) && !codes.includes(input)) { setCodes([...codes, input]); setInput(""); } }}>
              추가
            </button>
          </span>
        )}
      </div>
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
      <div className="chart-scroll mt-3"><div ref={ref} className="min-w-[360px]" /></div>
    </Section>
  );
}

/* ───────────── F11 이벤트 수동 입력 ───────────── */

const KINDS: MarketEventKind[] = ["EARNINGS", "EX_DIVIDEND", "SPLIT", "ETC"];

export function EventsEditor({ code, onChanged }: { code: string; onChanged: () => void }) {
  const [items, setItems] = useState<MarketEvent[]>([]);
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<MarketEventKind>("EARNINGS");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => { api.events(code).then((d) => setItems(d.items)).catch((e) => setError(String(e.message ?? e))); };
  useEffect(load, [code]);

  return (
    <Section title="이벤트 (실적발표·배당락)">
      <p className="mb-2 text-xs text-slate-500">
        안정적인 무료 자동 수집 소스를 확인하지 못해 수동 입력으로 운영합니다. 입력한 일정은 차트 하단 마커로 표시됩니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
               className="rounded border border-slate-300 px-2 py-1.5 text-xs" aria-label="이벤트 날짜" />
        <select value={kind} onChange={(e) => setKind(e.target.value as MarketEventKind)}
                className="rounded border border-slate-300 px-2 py-1.5 text-xs" aria-label="이벤트 종류">
          {KINDS.map((k) => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}
        </select>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="메모(선택)"
               className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-xs" />
        <button className="btn-ghost px-2 py-1 text-xs"
                onClick={async () => {
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError("날짜를 입력하십시오."); return; }
                  await api.addEvent(code, date, kind, memo);
                  setMemo(""); setError(null); load(); onChanged();
                }}>추가</button>
      </div>
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-xs">
          {items.map((e) => (
            <li key={`${e.date}-${e.kind}`} className="flex items-center justify-between py-1.5">
              <span><span className="num text-slate-500">{e.date}</span> · {EVENT_LABEL[e.kind]} {e.memo && `· ${e.memo}`}</span>
              <button className="text-slate-400 hover:text-red-600"
                      onClick={async () => { await api.removeEvent(code, e.date, e.kind); load(); onChanged(); }}>삭제</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ───────────── F11 리포트 내보내기 (클라이언트 사이드) ───────────── */

export function ExportButton({ targetId, filename }: { targetId: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-ghost text-xs"
      disabled={busy}
      onClick={async () => {
        const el = document.getElementById(targetId);
        if (!el) return;
        setBusy(true);
        try {
          const { default: html2canvas } = await import("html2canvas");
          const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
          const a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = `${filename}.png`;
          a.click();
        } finally { setBusy(false); }
      }}
    >
      {busy ? "생성 중…" : "PNG로 저장"}
    </button>
  );
}

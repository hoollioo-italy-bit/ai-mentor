import { useEffect, useRef, useState } from "react";
import { api, type SearchItem } from "../lib/api";
import { eok, pctRaw, signColor, won } from "../lib/format";
import { Badge } from "./Common";

const MARKETS = ["KOSPI", "KOSDAQ", "ETF", "ETN"] as const;
const RECENT_KEY = "recent-symbols-v1";

/** F1 종목 검색 — 300ms 디바운스, 시장구분 필터 칩, 최근 조회 5개 로컬 보관 */
export function SymbolSearch({ onSelect }: { onSelect: (code: string, name: string) => void }) {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState<string | null>(null);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<{ code: string; name: string }[]>(() => readRecent());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length === 0) { setItems([]); return; }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try { setItems((await api.search(q, market)).items); }
      catch { setItems([]); }
      finally { setLoading(false); }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q, market]);

  const pick = (code: string, name: string) => {
    const next = [{ code, name }, ...recent.filter((r) => r.code !== code)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 저장 실패는 무시 */ }
    setQ("");
    setItems([]);
    onSelect(code, name);
  };

  return (
    <div className="space-y-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="종목명 또는 종목코드 (예: 삼성전자, 005930)"
        className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-500"
        aria-label="종목 검색"
      />
      <div className="flex flex-wrap gap-1.5">
        <button className={`chip ${market === null ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-600"}`}
                onClick={() => setMarket(null)}>전체</button>
        {MARKETS.map((m) => (
          <button key={m}
                  className={`chip ${market === m ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-600"}`}
                  onClick={() => setMarket(market === m ? null : m)}>{m}</button>
        ))}
      </div>

      {recent.length > 0 && q.trim() === "" && (
        <div>
          <p className="label mb-1.5">최근 조회</p>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <button key={r.code} className="chip border-slate-300 text-slate-700 hover:bg-slate-50"
                      onClick={() => pick(r.code, r.name)}>
                {r.name} <span className="num text-slate-400">{r.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <p className="text-xs text-slate-500">검색 중…</p>}

      {items.length > 0 && (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {items.map((it) => (
            <li key={it.code}>
              <button className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                      onClick={() => pick(it.code, it.name)}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{it.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="num text-xs text-slate-500">{it.code}</span>
                    <Badge tone="info">{it.market}</Badge>
                    {it.status === null
                      ? <Badge tone="warn" title="종목 상태 동기화 미완료 — 가이드가 차단됩니다(S2)">상태 확인 불가</Badge>
                      : it.status.map((s) => <Badge key={s} tone="danger">{s}</Badge>)}
                    {it.avgTradingValue !== null && it.avgTradingValue < 3_000_000_000 &&
                      <Badge tone="warn" title="일평균 거래대금 30억 미만">유동성 부족</Badge>}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="num block text-sm">{won(it.price)}</span>
                  <span className={`num block text-xs ${signColor(it.changeRate)}`}>
                    {it.changeRate === null ? "-" : `${it.changeRate >= 0 ? "▲" : "▼"} ${pctRaw(Math.abs(it.changeRate))}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && items[0]?.avgTradingValue !== null && (
        <p className="text-[11px] text-slate-400">
          현재가·등락률은 저장된 최근 일봉 종가 기준입니다. 거래대금 {eok(items[0]?.avgTradingValue)} 이하 종목은 슬리피지가 커집니다.
        </p>
      )}
    </div>
  );
}

function readRecent(): { code: string; name: string }[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.slice(0, 5) : [];
  } catch { return []; }
}

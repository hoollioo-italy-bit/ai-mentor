import { useEffect, useState } from "react";
import { api, type PortfolioDetail } from "../lib/api";
import { Badge, Section } from "./Common";
import { won } from "../lib/format";

const LAST_KEY = "last-portfolio-v1";

export function PortfolioPicker({ value, onChange, refreshKey }: {
  value: PortfolioDetail | null;
  onChange: (p: PortfolioDetail | null) => void;
  refreshKey: number;
}) {
  const [list, setList] = useState<{ portfolio_id: string; name: string; cash: number }[]>([]);
  const [name, setName] = useState("기본 포트폴리오");
  const [cash, setCash] = useState(10_000_000);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.portfolios().then(async (d) => {
      setList(d.items);
      const saved = localStorage.getItem(LAST_KEY);
      const pick = d.items.find((x) => x.portfolio_id === saved) ?? d.items[0];
      if (pick) onChange(await api.portfolio(pick.portfolio_id));
      else onChange(null);
    }).catch(() => undefined);
  }, [refreshKey]);

  const select = async (id: string) => {
    localStorage.setItem(LAST_KEY, id);
    onChange(await api.portfolio(id));
  };

  return (
    <Section title="포트폴리오" right={value ? <Badge tone="info">{won(value.totalValue)}</Badge> : null}>
      {list.length > 0 && (
        <select
          value={value?.portfolio.portfolioId ?? ""}
          onChange={(e) => select(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          aria-label="포트폴리오 선택"
        >
          {list.map((p) => <option key={p.portfolio_id} value={p.portfolio_id}>{p.name} · {won(p.cash)}</option>)}
        </select>
      )}

      {value && value.positions.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-xs">
          {value.positions.map((p) => (
            <li key={p.code} className="flex items-center justify-between py-1.5">
              <span className="min-w-0 truncate">{p.name} <span className="num text-slate-400">{p.qty}주</span></span>
              <span className={`num ${p.unrealizedPnl >= 0 ? "text-red-600" : "text-blue-600"}`}>
                {won(p.unrealizedPnl)} ({(p.unrealizedRate * 100).toFixed(1)}%)
              </span>
            </li>
          ))}
        </ul>
      )}

      {value && value.concentration.length > 0 && (
        <div className="mt-2 space-y-1">
          {value.concentration.map((c) => (
            <p key={c.code} className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
              ⚠ {c.code} — {c.flag.reason}
            </p>
          ))}
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-slate-500">새 포트폴리오 만들기</summary>
        <div className="mt-2 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs" placeholder="이름" />
          <input type="number" value={cash} step={1_000_000} min={0}
                 onChange={(e) => setCash(Math.max(0, Number(e.target.value)))}
                 className="num w-full rounded border border-slate-300 px-2 py-1.5 text-xs" placeholder="초기자본" />
          <button className="btn-primary w-full text-xs" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api.createPortfolio(name, cash);
                      const d = await api.portfolios();
                      setList(d.items);
                      await select(r.portfolioId);
                    } finally { setBusy(false); }
                  }}>
            생성
          </button>
        </div>
      </details>
    </Section>
  );
}

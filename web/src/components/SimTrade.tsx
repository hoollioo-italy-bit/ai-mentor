import { useEffect, useState } from "react";
import { api, type EstimateResult, type PortfolioDetail } from "../lib/api";
import { Badge, ErrorBox, Section } from "./Common";
import { eok, pct, signColor, won } from "../lib/format";
import type { AnalysisPayload } from "@app/shared";

/** F7 비용 반영 예상수익률 + F8 모의 체결 */
export function SimTrade({ p, portfolio, onTraded }: {
  p: AnalysisPayload;
  portfolio: PortfolioDetail | null;
  onTraded: () => void;
}) {
  const close = p.snapshot.close;
  const [buyPrice, setBuyPrice] = useState(Math.round(p.guide.entry?.high ?? close));
  const [sellPrice, setSellPrice] = useState(Math.round(p.guide.target?.price ?? close * 1.05));
  const [qty, setQty] = useState(10);
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!(buyPrice > 0 && sellPrice > 0 && qty > 0)) { setEst(null); return; }
    let alive = true;
    const id = window.setTimeout(() => {
      api.estimate(p.symbol.code, buyPrice, sellPrice, qty)
        .then((d) => { if (alive) { setEst(d); setError(null); } })
        .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [p.symbol.code, buyPrice, sellPrice, qty]);

  const execute = async (side: "BUY" | "SELL") => {
    if (!portfolio) { setError("먼저 포트폴리오를 선택하거나 생성하십시오."); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.trade({
        portfolioId: portfolio.portfolio.portfolioId,
        code: p.symbol.code, side,
        price: side === "BUY" ? buyPrice : sellPrice, qty,
        stopLoss: p.guide.stopLoss?.price ?? null,
        target: p.guide.target?.price ?? null,
      });
      setResult(`${side === "BUY" ? "매수" : "매도"} 체결 — 잔고 ${won(r.cash)} · 비용 ${won(r.cost.fee + r.cost.tax + r.cost.slippage)}`
        + (r.concentrationWarning ? ` · ⚠ ${r.concentrationWarning.reason}` : ""));
      onTraded();
    } catch (e) {
      setError(String((e as Error).message));
    } finally { setBusy(false); }
  };

  return (
    <Section title="모의투자" right={portfolio ? <Badge tone="info">현금 {won(portfolio.portfolio.cash)}</Badge> : null}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="매수가" value={buyPrice} onChange={setBuyPrice} />
        <Field label="매도가(목표)" value={sellPrice} onChange={setSellPrice} />
        <Field label="수량(주)" value={qty} onChange={setQty} step={1} />
      </div>

      {est && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border-2 border-slate-300 p-3">
              <p className="label">비용 차감 후 순수익 (주 표시)</p>
              <p className={`num text-lg font-semibold ${signColor(est.netProfit)}`}>{won(est.netProfit)}</p>
              <p className={`num text-sm ${signColor(est.netReturnRate)}`}>{pct(est.netReturnRate)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="label">세전 수익 (참고)</p>
              <p className="num text-sm text-slate-600">{won(est.grossProfit)} · {pct(est.grossReturnRate)}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                슬리피지율 {(est.slippageRate * 100).toFixed(2)}% · 거래대금 {eok(est.avgTradingValue)}
              </p>
            </div>
          </div>

          <table className="mt-3 w-full text-xs">
            <tbody>
              {[
                ["매수수수료", est.cost.buyFee], ["매도수수료", est.cost.sellFee],
                ["거래세", est.cost.sellTax], ["슬리피지", est.cost.slippage],
              ].map(([k, v]) => (
                <tr key={k as string} className="border-b border-slate-100">
                  <td className="py-1 text-slate-500">{k as string}</td>
                  <td className="num py-1 text-right text-slate-800">{won(v as number)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5">합계</td>
                <td className="num py-1.5 text-right">{won(est.cost.total)} ({(est.cost.totalRate * 100).toFixed(3)}%)</td>
              </tr>
            </tbody>
          </table>

          {est.costWarning && (
            <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              ⚠ 비용이 기대수익의 {((est.costRatioOfGross ?? 0) * 100).toFixed(0)}% 를 차지합니다 (경고 기준 30%).
            </p>
          )}
          {est.liquidityWarning && (
            <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              ⚠ 유동성 부족 종목 — 실제 체결가가 입력값과 크게 달라질 수 있습니다 (S4).
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex gap-2">
        <button className="btn-primary" onClick={() => execute("BUY")} disabled={busy || !portfolio}>모의 매수</button>
        <button className="btn-ghost" onClick={() => execute("SELL")} disabled={busy || !portfolio}>모의 매도</button>
      </div>
      {result && <p className="mt-2 rounded bg-slate-100 px-3 py-2 text-xs text-slate-700">{result}</p>}
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
    </Section>
  );
}

function Field({ label, value, onChange, step = 10 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="number" min={0} step={step} value={value}
             onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
             className="num mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500" />
    </label>
  );
}

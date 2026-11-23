import { HORIZONS, HORIZON_CONFIG, HORIZON_LABEL, type Horizon } from "@app/shared";
import type { Toggles } from "./Chart";

/** F2 투자기간 선택 + F3 자동 결정된 차트 유형 표시(수동 변경 토글 포함) */
export function HorizonTabs({
  value, onChange, blocked,
}: { value: Horizon; onChange: (h: Horizon) => void; blocked: Set<Horizon> }) {
  const cfg = HORIZON_CONFIG[value];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {HORIZONS.map((h) => {
          const isBlocked = blocked.has(h);
          return (
            <button
              key={h}
              disabled={isBlocked}
              title={isBlocked ? "상장 1년 미만 종목은 이 기간을 선택할 수 없습니다 (S6)" : undefined}
              onClick={() => onChange(h)}
              className={`chip ${value === h ? "border-slate-900 bg-slate-900 text-white"
                : isBlocked ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
            >
              {HORIZON_LABEL[h]}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        자동 결정: 주 차트 <b className="text-slate-700">{intervalLabel(cfg.primary)}</b> ·
        상위 확인 <b className="text-slate-700">{cfg.higherLabel}</b> ·
        기본 지표 {cfg.indicators.join(", ")}
      </p>
    </div>
  );
}

export function intervalLabel(i: string): string {
  return { "1m": "1분봉", "5m": "5분봉", "30m": "30분봉", "1d": "일봉", "1w": "주봉", "1M": "월봉" }[i] ?? i;
}

const TOGGLE_LABELS: { key: keyof Toggles; label: string }[] = [
  { key: "sr", label: "지지·저항" },
  { key: "trendline", label: "추세선" },
  { key: "channel", label: "추세채널" },
  { key: "fib", label: "피보나치" },
  { key: "cross", label: "골든·데드크로스" },
  { key: "squeeze", label: "볼린저 스퀴즈" },
  { key: "volumeSpike", label: "거래량 급증" },
  { key: "event", label: "이벤트" },
  { key: "ma", label: "이동평균" },
  { key: "vwap", label: "VWAP" },
  { key: "bollinger", label: "볼린저 밴드" },
  { key: "volume", label: "거래량" },
];

/** F4 주석 on/off 체크박스 */
export function AnnotationToggles({ value, onChange }: { value: Toggles; onChange: (t: Toggles) => void }) {
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
      <legend className="label mb-1">차트 주석</legend>
      {TOGGLE_LABELS.map(({ key, label }) => (
        <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={value[key]}
                 onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
                 className="h-3.5 w-3.5 rounded border-slate-300" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

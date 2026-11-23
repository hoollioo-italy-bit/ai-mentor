import { useEffect, useRef } from "react";
import {
  ColorType, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type SeriesMarker, type UTCTimestamp,
} from "lightweight-charts";
import type { Annotation, Candle, IndicatorSeries, Interval } from "@app/shared";

/**
 * F4 — 주석을 **선·도형·라벨로 직접 그린다.** 텍스트 설명만 제공하지 않는다.
 * 색상 규약(§F4): 지지 #2563EB · 저항 #DC2626 · 추세 #6B7280 · 시그널 #EA580C · 이벤트 #7C3AED
 *
 * 시각 표시: lightweight-charts 는 UTC 로 렌더링하므로 KST(+9h) 를 더해 넘긴 뒤
 * 축 라벨이 한국 시간으로 보이게 한다.
 */

const KST = 9 * 3600;
const toTime = (ms: number): UTCTimestamp => ((ms / 1000) | 0) + KST as UTCTimestamp;

export const COLORS = {
  support: "#2563EB", resistance: "#DC2626", trend: "#6B7280",
  signal: "#EA580C", event: "#7C3AED",
  up: "#DC2626", down: "#2563EB",
  ma: { ma5: "#F59E0B", ma20: "#0EA5E9", ma60: "#8B5CF6", ma120: "#10B981", ma200: "#64748B" } as Record<string, string>,
  vwap: "#EC4899",
};

export type Toggles = {
  sr: boolean; trendline: boolean; channel: boolean; fib: boolean;
  cross: boolean; squeeze: boolean; volumeSpike: boolean; event: boolean;
  ma: boolean; vwap: boolean; bollinger: boolean; volume: boolean;
};

export const DEFAULT_TOGGLES: Toggles = {
  sr: true, trendline: true, channel: false, fib: true,
  cross: true, squeeze: true, volumeSpike: true, event: true,
  ma: true, vwap: true, bollinger: true, volume: true,
};

type Props = {
  candles: Candle[];
  indicators: IndicatorSeries;
  annotations: Annotation[];
  interval: Interval;
  toggles: Toggles;
  height?: number;
  compact?: boolean;
};

export function Chart({ candles, indicators, annotations, interval, toggles, height = 420, compact = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;

    const chart = createChart(el, {
      height,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#334155", fontSize: 11 },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: "#e2e8f0", scaleMargins: { top: 0.08, bottom: toggles.volume ? 0.26 : 0.08 } },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: interval === "1m" || interval === "5m" || interval === "30m",
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: { locale: "ko-KR", priceFormatter: (p: number) => Math.round(p).toLocaleString("ko-KR") },
    });
    chartRef.current = chart;

    /* 0) 배경 음영 — 볼린저 스퀴즈 구간 (가장 먼저 그려 뒤에 깔리게 한다) */
    if (toggles.squeeze) {
      const squeezes = annotations.filter((a): a is Extract<Annotation, { kind: "BB_SQUEEZE" }> => a.kind === "BB_SQUEEZE");
      if (squeezes.length > 0) {
        const shade = chart.addHistogramSeries({
          priceScaleId: "squeeze", color: "rgba(100,116,139,0.10)",
          priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
        });
        shade.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
        shade.setData(candles.map((c) => ({
          time: toTime(c.t),
          value: squeezes.some((s) => c.t >= s.from && c.t <= s.to) ? 1 : 0,
          color: "rgba(100,116,139,0.10)",
        })));
      }
    }

    /* 1) 거래량 — 급증 봉은 강조색 */
    if (toggles.volume) {
      const spikes = new Set(
        annotations.filter((a): a is Extract<Annotation, { kind: "VOLUME_SPIKE" }> => a.kind === "VOLUME_SPIKE").map((a) => a.t),
      );
      const vol = chart.addHistogramSeries({
        priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      vol.setData(candles.map((c) => ({
        time: toTime(c.t),
        value: c.v,
        color: toggles.volumeSpike && spikes.has(c.t) ? COLORS.signal : c.c >= c.o ? "rgba(220,38,38,0.35)" : "rgba(37,99,235,0.35)",
      })));
    }

    /* 2) 볼린저 밴드 */
    if (toggles.bollinger && indicators.bollinger) {
      for (const [key, color] of [["upper", "#94a3b8"], ["mid", "#cbd5e1"], ["lower", "#94a3b8"]] as const) {
        const pts = indicators.bollinger[key];
        if (!pts) continue;
        const s = chart.addLineSeries({
          color, lineWidth: 1, lineStyle: key === "mid" ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData(pts.filter((p) => p.v !== null).map((p) => ({ time: toTime(p.t), value: p.v as number })));
      }
    }

    /* 3) 캔들 — 한국 관행(상승 빨강 / 하락 파랑) */
    const main: ISeriesApi<"Candlestick"> = chart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down,
      borderUpColor: COLORS.up, borderDownColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
    });
    main.setData(candles.map((c) => ({ time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));

    /* 4) 이동평균 · VWAP */
    if (toggles.ma && indicators.ma) {
      for (const [key, pts] of Object.entries(indicators.ma)) {
        const s = chart.addLineSeries({
          color: COLORS.ma[key] ?? "#94a3b8", lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: key.toUpperCase(),
        });
        s.setData(pts.filter((p) => p.v !== null).map((p) => ({ time: toTime(p.t), value: p.v as number })));
      }
    }
    if (toggles.vwap && indicators.vwap) {
      const s = chart.addLineSeries({
        color: COLORS.vwap, lineWidth: 1, lineStyle: LineStyle.Dotted,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: "VWAP",
      });
      s.setData(indicators.vwap.filter((p) => p.v !== null).map((p) => ({ time: toTime(p.t), value: p.v as number })));
    }

    /* 5) 전일 종가선 (당일 차트) */
    if (indicators.prevClose != null) {
      main.createPriceLine({
        price: indicators.prevClose, color: "#64748b", lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: "전일 종가",
      });
    }

    /* 6) 지지·저항 수평선 + 라벨 */
    if (toggles.sr) {
      for (const a of annotations) {
        if (a.kind !== "SUPPORT" && a.kind !== "RESISTANCE") continue;
        main.createPriceLine({
          price: a.price,
          color: a.kind === "SUPPORT" ? COLORS.support : COLORS.resistance,
          lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: a.label,
        });
      }
    }

    /* 7) 추세선 · 추세채널 (회색 사선 / 반투명 밴드) */
    if (toggles.trendline) {
      for (const a of annotations) {
        if (a.kind !== "TRENDLINE") continue;
        const s = chart.addLineSeries({
          color: COLORS.trend, lineWidth: 2, lineStyle: LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: a.label,
        });
        s.setData([
          { time: toTime(a.p1.t), value: a.p1.price },
          { time: toTime(a.p2.t), value: a.p2.price },
        ]);
      }
    }
    if (toggles.channel) {
      for (const a of annotations) {
        if (a.kind !== "CHANNEL") continue;
        for (const sign of [1, -1]) {
          const s = chart.addLineSeries({
            color: "rgba(107,114,128,0.45)", lineWidth: 1, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          s.setData([
            { time: toTime(a.p1.t), value: a.p1.price + sign * a.width },
            { time: toTime(a.p2.t), value: a.p2.price + sign * a.width },
          ]);
        }
      }
    }

    /* 8) 피보나치 — 점선 + 비율 라벨 */
    if (toggles.fib) {
      const fib = annotations.find((a): a is Extract<Annotation, { kind: "FIBONACCI" }> => a.kind === "FIBONACCI");
      for (const lv of fib?.levels ?? []) {
        main.createPriceLine({
          price: lv.price, color: "rgba(107,114,128,0.7)", lineWidth: 1, lineStyle: LineStyle.Dotted,
          axisLabelVisible: false, title: `Fib ${(lv.ratio * 100).toFixed(1)}%`,
        });
      }
    }

    /* 9) 마커 — 골든/데드크로스, 이벤트 */
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    if (toggles.cross) {
      for (const a of annotations) {
        if (a.kind !== "MA_CROSS") continue;
        markers.push({
          time: toTime(a.t),
          position: a.cross === "GOLDEN" ? "belowBar" : "aboveBar",
          color: COLORS.signal,
          shape: a.cross === "GOLDEN" ? "arrowUp" : "arrowDown",
          text: `${a.cross === "GOLDEN" ? "골든" : "데드"}${a.fast}/${a.slow}`,
        });
      }
    }
    if (toggles.event) {
      for (const a of annotations) {
        if (a.kind !== "EVENT") continue;
        markers.push({ time: toTime(a.t), position: "belowBar", color: COLORS.event, shape: "circle", text: a.eventKind });
      }
    }
    markers.sort((x, y) => (x.time as number) - (y.time as number));
    if (markers.length) main.setMarkers(markers);

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [candles, indicators, annotations, interval, toggles, height]);

  if (candles.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500"
           style={{ height }}>
        표시할 시세 데이터가 없습니다.
      </div>
    );
  }
  return (
    <div className="chart-scroll">
      <div ref={ref} className={compact ? "min-w-[320px]" : "min-w-[480px]"} />
    </div>
  );
}

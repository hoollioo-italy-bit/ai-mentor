import type { Interval } from "./providers/types.js";

/** F2 투자기간 */
export type Horizon = "1d" | "1w" | "2w" | "1m" | "3m" | "6m" | "1y";

export const HORIZONS: Horizon[] = ["1d", "1w", "2w", "1m", "3m", "6m", "1y"];

export const HORIZON_LABEL: Record<Horizon, string> = {
  "1d": "당일",
  "1w": "1주",
  "2w": "2주",
  "1m": "1개월",
  "3m": "3개월",
  "6m": "6개월",
  "1y": "1년",
};

export type IndicatorKey =
  | "VWAP"
  | "MA5" | "MA20" | "MA60" | "MA120" | "MA200"
  | "VOLUME" | "PREV_CLOSE"
  | "BOLLINGER" | "RSI" | "MACD"
  | "FIBONACCI" | "TRENDLINE" | "SR" | "CHANNEL" | "VOLUME_PROFILE";

export type HorizonConfig = {
  horizon: Horizon;
  label: string;
  /** 주 차트 */
  primary: Interval;
  /** 주 차트에 적재할 봉 수 */
  primaryBars: number;
  /** 상위 확인 차트 */
  higher: Interval;
  /** 상위 확인 차트에 적재할 봉 수 */
  higherBars: number;
  /** 상위 확인 차트 표기 (예: "일봉 20일") */
  higherLabel: string;
  indicators: IndicatorKey[];
  /** 사후 채점 지평(영업일). F9 */
  scoreDays: number[];
  /** 장기 지표 요구 — 상장 1년 미만 종목 차단 판정에 사용 (S6) */
  requiresLongHistory: boolean;
};

/**
 * F3 기간별 차트 유형 자동 결정 — 하드코딩 설정 테이블.
 * primaryBars 는 §2.2-2 봉 수 상한(1분봉 2,000 / 일봉 1,200) 이내로 고정한다.
 */
export const HORIZON_CONFIG: Record<Horizon, HorizonConfig> = {
  "1d": {
    horizon: "1d", label: "당일",
    primary: "1m", primaryBars: 2000,
    higher: "1d", higherBars: 20, higherLabel: "일봉 20일",
    indicators: ["VWAP", "MA5", "MA20", "VOLUME", "PREV_CLOSE"],
    scoreDays: [5, 20, 60], requiresLongHistory: false,
  },
  "1w": {
    horizon: "1w", label: "1주",
    primary: "5m", primaryBars: 1200,
    higher: "1d", higherBars: 60, higherLabel: "일봉 60일",
    indicators: ["VWAP", "BOLLINGER", "RSI", "VOLUME"],
    scoreDays: [5, 20, 60], requiresLongHistory: false,
  },
  "2w": {
    horizon: "2w", label: "2주",
    primary: "30m", primaryBars: 600,
    higher: "1d", higherBars: 120, higherLabel: "일봉 120일",
    indicators: ["MA20", "MA60", "MACD", "VOLUME"],
    scoreDays: [5, 20, 60], requiresLongHistory: false,
  },
  "1m": {
    horizon: "1m", label: "1개월",
    primary: "1d", primaryBars: 260,
    higher: "1w", higherBars: 52, higherLabel: "주봉 1년",
    indicators: ["MA5", "MA20", "MA60", "RSI", "BOLLINGER"],
    scoreDays: [5, 20, 60], requiresLongHistory: false,
  },
  "3m": {
    horizon: "3m", label: "3개월",
    primary: "1d", primaryBars: 400,
    higher: "1w", higherBars: 104, higherLabel: "주봉 2년",
    indicators: ["MA20", "MA60", "MACD", "FIBONACCI"],
    scoreDays: [5, 20, 60], requiresLongHistory: false,
  },
  "6m": {
    horizon: "6m", label: "6개월",
    primary: "1d", primaryBars: 700,
    higher: "1w", higherBars: 156, higherLabel: "주봉 3년",
    indicators: ["MA60", "MA120", "TRENDLINE", "SR"],
    scoreDays: [5, 20, 60], requiresLongHistory: true,
  },
  "1y": {
    horizon: "1y", label: "1년",
    primary: "1w", primaryBars: 260,
    higher: "1M", higherBars: 60, higherLabel: "월봉 5년",
    indicators: ["MA120", "MA200", "CHANNEL", "VOLUME_PROFILE"],
    scoreDays: [5, 20, 60], requiresLongHistory: true,
  },
};

/** §2.2-2 계산 대상 봉 수 상한 */
export const MAX_BARS: Record<Interval, number> = {
  "1m": 2000, "5m": 2000, "30m": 2000,
  "1d": 1200, "1w": 1200, "1M": 1200,
};

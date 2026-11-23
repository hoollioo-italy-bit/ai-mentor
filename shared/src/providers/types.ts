/**
 * 내부 표준 타입 — 명세 §3.1. **변경 금지.**
 *
 * 앱 전체(Worker 핸들러 · 분석 로직 · 프론트엔드)는 이 타입만 참조한다.
 * 소스별 원본 필드명은 `worker/src/providers/` 폴더 밖에 등장해서는 안 된다(§3.2-1).
 */

export type Interval = "1m" | "5m" | "30m" | "1d" | "1w" | "1M";

export type Candle = {
  /** epoch ms — 봉 시작시각 (KST 기준 계산 후 UTC 저장) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** 거래량(주) */
  v: number;
  /** 거래대금(원) */
  va?: number;
  /** 수정주가 반영 여부. 소스 전환 시 정합성 판단에 사용 */
  adj: boolean;
};

export type Market = "KOSPI" | "KOSDAQ" | "ETF" | "ETN";

export type StockSymbol = {
  /** "005930" */
  code: string;
  name: string;
  market: Market;
  /** 소스별 원본 키 (KIS 시장구분 J/NX/UN 등) */
  providerKey?: string;
  /** ["관리종목","거래정지","투자경고"] */
  status?: string[];
};

export interface PriceProvider {
  searchSymbols(keyword: string): Promise<StockSymbol[]>;
  getCandles(code: string, interval: Interval, from: Date, to: Date): Promise<Candle[]>;
  getQuote(code: string): Promise<{ price: number; change: number; changeRate: number; t: number }>;
}

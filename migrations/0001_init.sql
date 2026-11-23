-- 명세 §4 데이터 모델 (D1 / SQLite) — 원문 그대로

-- 종목마스터
CREATE TABLE symbols (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  market            TEXT NOT NULL,        -- KOSPI | KOSDAQ | ETF | ETN
  provider_key      TEXT,
  status            TEXT,                 -- JSON 배열: ["관리종목", ...]
  listed_at         TEXT,                 -- YYYY-MM-DD
  avg_trading_value INTEGER,              -- 최근 20일 평균 거래대금(원)
  updated_at        INTEGER NOT NULL
);

-- 시세 (정규화 포맷)
CREATE TABLE candles (
  code     TEXT    NOT NULL,
  interval TEXT    NOT NULL,
  t        INTEGER NOT NULL,              -- epoch ms
  o REAL, h REAL, l REAL, c REAL,
  v        INTEGER,
  va       INTEGER,
  adj      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (code, interval, t)
);
CREATE INDEX idx_candles_lookup ON candles(code, interval, t DESC);

-- 시그널 이력 + 사후 채점  ★ 최우선 기능
CREATE TABLE signals (
  signal_id     TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  horizon       TEXT NOT NULL,            -- 1d|1w|2w|1m|3m|6m|1y
  signal_type   TEXT NOT NULL,            -- GOLDEN_CROSS | RSI_OVERSOLD | ...
  indicators    TEXT NOT NULL,            -- JSON: 생성 시점 지표값 전부
  market_regime TEXT,
  entry REAL, stop_loss REAL, target REAL,
  risk_reward   REAL,
  scored_d5     TEXT,                     -- JSON: {ret, hitStop, hitTarget}
  scored_d20    TEXT,
  scored_d60    TEXT
);
CREATE INDEX idx_signals_type ON signals(signal_type);
CREATE INDEX idx_signals_pending ON signals(created_at);

-- 분석 결과 캐시 (CPU 10ms 대응)
CREATE TABLE analysis_cache (
  cache_key  TEXT PRIMARY KEY,            -- code:horizon:yyyymmdd
  payload    TEXT NOT NULL,               -- JSON: 지표·주석·해석·가이드 전체
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 모의투자
CREATE TABLE portfolios (
  portfolio_id TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  initial_cash INTEGER NOT NULL,
  cash         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE trades (
  trade_id     TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  code         TEXT NOT NULL,
  side         TEXT NOT NULL,             -- BUY | SELL
  price        REAL NOT NULL,
  qty          INTEGER NOT NULL,
  traded_at    INTEGER NOT NULL,
  fee          INTEGER NOT NULL,
  tax          INTEGER NOT NULL,
  slippage     INTEGER NOT NULL,
  signal_id    TEXT                       -- 이 시그널을 보고 실행했다면 연결
);
CREATE INDEX idx_trades_pf ON trades(portfolio_id, traded_at);

CREATE TABLE positions (
  portfolio_id TEXT NOT NULL,
  code         TEXT NOT NULL,
  qty          INTEGER NOT NULL,
  avg_price    REAL NOT NULL,
  stop_loss    REAL,
  target       REAL,
  PRIMARY KEY (portfolio_id, code)
);

CREATE TABLE watchlist (
  user_id    TEXT NOT NULL,
  code       TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,            -- 분봉 수집 대상 판정에 사용
  PRIMARY KEY (user_id, code)
);

CREATE TABLE alerts (
  alert_id   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  code       TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- STOP_LOSS | TARGET
  threshold  REAL NOT NULL,
  fired_at   INTEGER
);

CREATE TABLE events (
  code   TEXT NOT NULL,
  date   TEXT NOT NULL,                   -- YYYY-MM-DD
  kind   TEXT NOT NULL,                   -- EARNINGS | EX_DIVIDEND | SPLIT | ETC
  memo   TEXT,
  PRIMARY KEY (code, date, kind)
);

-- 메일 발송 큐 (GAS 릴레이용)
CREATE TABLE mail_queue (
  mail_id    TEXT PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html_body  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_mail_pending ON mail_queue(status, created_at);

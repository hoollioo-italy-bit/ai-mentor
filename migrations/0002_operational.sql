-- 명세 §4 외 운영 보조 스키마.
-- 추가 사유를 각 객체에 주석으로 남긴다. §4 원문 테이블은 변경하지 않는다.

-- [사유] §8.1-2 소스 변경 감지 알림의 중복 발송 억제 + 폴백 체인 상태 판정(S1).
CREATE TABLE source_health (
  source        TEXT PRIMARY KEY,         -- naver | krx | kis
  last_ok_at    INTEGER,
  last_fail_at  INTEGER,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,                     -- JSON: {url, status, bodyHead}
  last_notified_at INTEGER
);

-- [사유] §1.2 S1 — 화면에 노출할 "현재 데이터가 어느 소스에서 왔는가"를
--        요청 경로 계산 없이 즉시 읽기 위한 종목·주기별 적재 상태.
CREATE TABLE ingest_state (
  code        TEXT NOT NULL,
  interval    TEXT NOT NULL,
  source      TEXT NOT NULL,              -- naver | krx | kis | cache
  last_bar_t  INTEGER,
  fetched_at  INTEGER NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (code, interval)
);

-- [사유] §3.5 분봉 축적 대상에서 자동 제외된 종목의 기록(감사 추적).
--        Workers Logs 는 보존기간이 짧아 사후 확인이 어렵다.
CREATE TABLE ingest_exclusion_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  excluded_at INTEGER NOT NULL
);

-- [사유] F9 동일 종목·기간·시그널에 대해 같은 영업일 내 중복 레코드가 쌓이면
--        적중률 집계가 왜곡된다. KST 기준 일자로 유일성을 강제한다.
CREATE UNIQUE INDEX idx_signals_dedup
  ON signals(code, horizon, signal_type, date(created_at / 1000, 'unixepoch', '+9 hours'));

-- [사유] F9 채점 Cron 이 미채점 레코드만 스캔하도록 (§2.2-3 SQL 로 잘라 가져오기).
CREATE INDEX idx_signals_unscored_d5  ON signals(created_at) WHERE scored_d5  IS NULL;
CREATE INDEX idx_signals_unscored_d20 ON signals(created_at) WHERE scored_d20 IS NULL;
CREATE INDEX idx_signals_unscored_d60 ON signals(created_at) WHERE scored_d60 IS NULL;

-- [사유] F10 중복 발송 방지 조회 경로.
CREATE INDEX idx_alerts_user_code ON alerts(user_id, code, kind);

-- [사유] analysis_cache 만료분 정리 Cron.
CREATE INDEX idx_analysis_expires ON analysis_cache(expires_at);

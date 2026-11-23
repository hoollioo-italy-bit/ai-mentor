# 국내 주식 차트분석 · 모의투자 웹앱

코스피·코스닥·ETF·ETN 의 **차트 지표 상태를 시각적으로 해석하고, 그 해석이 실제로 맞았는지
사후 검증하는 판단 보조 도구**입니다. 매매 지시를 생성하지 않습니다.

> 본 정보는 투자 판단 참고용이며 투자 권유가 아닙니다. 투자 결과의 책임은 이용자 본인에게 있습니다.

---

## ⚠ 운영 투입 전 반드시 확인할 것

이 저장소의 외부 데이터 어댑터는 **실호출로 검증되지 않았습니다(UNVERIFIED).**
구현 환경의 네트워크 정책이 `api.finance.naver.com`, `fchart.stock.naver.com`,
`data.krx.co.kr` 을 모두 차단해 명세 §11("추측하지 말고 직접 호출하여 확인")을
만족시킬 수 없었기 때문입니다.

```bash
npm run verify:provider -- --raw      # 로컬에서 실제 응답과 대조
```

자세한 절차는 [`docs/provider-migration.md`](docs/provider-migration.md) 를 따르십시오.
세율(`worker/src/analysis/cost.ts`) 역시 같은 이유로 미검증이며,
`TAX_RATE_VERIFIED_AT` 이 `null` 인 동안에는 검증되지 않은 값입니다.

검증 전에도 **잘못된 데이터가 조용히 분석에 유입되지는 않습니다.**
zod 스키마 검증이 예외를 던지고(§3.2-3), 관리자 알림이 큐에 쌓이며(§8.1-2),
화면에서는 안전장치 S1 이 발동해 가이드 생성이 차단됩니다.

---

## 구조

```
/worker      Cloudflare Workers + Hono (API · Cron)
/web         React 18 + Vite (Cloudflare Pages)
/shared      내부 표준 타입 (providers/types.ts 포함) — 앱 전체가 이것만 참조
/migrations  D1 마이그레이션 SQL
/docs        gas-mail-relay.gs, provider-migration.md
/scripts     verify-provider.ts (외부 소스 응답 검증 하네스)
/legacy      이전 앱 보관 (ai-mentor/index.html) — 이번 앱과 무관
```

### 설계 축

| 원칙 | 구현 위치 |
|---|---|
| 표현 제약 — 단정적 권유 금지, 3요소 구조만 허용 | `worker/src/analysis/interpret.ts` (규칙 기반 템플릿. LLM 자유 생성 없음) |
| 안전장치 S1~S7 — 경고가 아니라 **기능 차단** | `worker/src/analysis/safety.ts` |
| Provider 추상화 — 원본 필드명이 `providers/` 를 벗어나지 않음 | `worker/src/providers/` |
| CPU 10ms — 요청 경로에서 무거운 계산 금지 | `worker/src/cron/precompute.ts` → `analysis_cache` |
| 사후 검증 루프 | `worker/src/analysis/signals.ts` + `worker/src/cron/score.ts` |

---

## 로컬 실행

```bash
npm install --legacy-peer-deps      # npm 10 의 peer 해석 버그 회피
cp .dev.vars.example .dev.vars      # RELAY_TOKEN 등을 채운다

# D1 · KV 생성 (최초 1회) — 출력된 id 를 wrangler.toml 에 기입
npx wrangler d1 create kr-stock-db
npx wrangler kv namespace create CACHE

npm run db:migrate:local            # 로컬 D1 마이그레이션
npm run dev:worker                  # http://127.0.0.1:8787
npm run dev:web                     # http://127.0.0.1:5173 (/api → 8787 프록시)
```

`PRICE_PROVIDER=mock` 으로 두면 외부 호출 없이 결정론적 시세로 전체 화면을 돌려볼 수 있습니다.
로컬에서는 Cloudflare Access 헤더가 없으므로 `DEV_USER` 값이 사용자 식별자로 쓰입니다.

### 테스트 · 타입 검사

```bash
npm test          # vitest (workerd 런타임) — 지표·비용·안전장치·파싱 105건
npm run typecheck # shared / worker / web
```

---

## 배포

### 1. Worker

```bash
npx wrangler d1 create kr-stock-db           # database_id 를 wrangler.toml 에 기입
npx wrangler kv namespace create CACHE       # id 를 wrangler.toml 에 기입
npm run db:migrate:remote

npx wrangler secret put RELAY_TOKEN          # openssl rand -hex 32
npx wrangler secret put KIS_APP_KEY          # Phase 4 전환 시에만
npx wrangler secret put KIS_APP_SECRET

npx wrangler deploy
```

`wrangler.toml` 의 `[vars]` 에서 `ADMIN_EMAIL`(소스 이상 알림 수신), `WEB_ORIGIN`(CORS 허용
출처)을 채웁니다. `WEB_ORIGIN` 이 비어 있으면 CORS 가 `*` 로 열리므로 운영에서는 반드시 지정하십시오.

### 2. Pages (프론트엔드)

```bash
npm -w web run build          # web/dist 생성
npx wrangler pages deploy web/dist --project-name kr-stock-web
```

빌드 시 `VITE_API_BASE` 에 Worker 도메인을 지정합니다(동일 도메인에 라우팅한다면 생략).

```bash
VITE_API_BASE=https://kr-stock-worker.<계정>.workers.dev npm -w web run build
```

### 3. Cloudflare Access (Zero Trust, 무료 50석)

1. Zero Trust 대시보드 → **Access → Applications → Add an application → Self-hosted**
2. Application domain 에 Pages 도메인과 Worker 도메인을 등록
3. **Policy**: Action `Allow`, Include → `Emails` 에 사용할 계정 주소를 지정
4. **Path 제외**: `/internal/*` 를 Access 적용 대상에서 **반드시 제외**
   (Bypass 정책 또는 별도 Application 로 분리). 제외하지 않으면 Apps Script 릴레이가
   로그인 페이지로 리다이렉트되어 메일이 영원히 PENDING 으로 남습니다.
5. Access 를 통과한 요청에는 `Cf-Access-Authenticated-User-Email` 헤더가 주입되며,
   이 값이 `user_id` 로 쓰입니다.

### 4. 알림 메일 릴레이

[`docs/gas-mail-relay.gs`](docs/gas-mail-relay.gs) 상단의 설치 절차를 따릅니다.
스크립트 속성 `WORKER_BASE_URL`, `RELAY_TOKEN`, `ADMIN_EMAIL` 을 채우고 `setupTrigger()` 를
1회 실행하면 5분 간격으로 동작합니다.

---

## Cron Triggers (모두 UTC 기준)

| 표현식 | KST | 하는 일 |
|---|---|---|
| `0 20 * * *` | 05:00 | KRX 종목마스터 적재 → D1 + KV 캐시, 거래대금·상태 보강 |
| `*/10 0-6 * * 1-5` | 장중 10분 | 분봉 축적 (대상 50종목 상한, §3.5) |
| `0 7 * * 1-5` | 16:00 | 일봉·지수 적재 + `analysis_cache` 사전 계산 |
| `0 9 * * 1-5` | 18:00 | **시그널 사후 채점 (F9)** |
| `*/30 0-6 * * 1-5` | 장중 30분 | 손절·목표 도달 알림 → `mail_queue` |

Cron Trigger 수 제한에 걸리면 `worker/src/index.ts` 의 `runCron()` 이 표현식으로 분기하므로,
여러 일정을 하나의 표현식으로 합치고 핸들러 안에서 시각 조건을 추가하면 됩니다.

---

## 무료 플랜 한도 대응

| 항목 | 대응 |
|---|---|
| Workers CPU 10ms/요청 | 지표·주석·가이드를 Cron 이 사전 계산해 `analysis_cache` 에 JSON 저장. 요청은 읽기만 수행 |
| | 실시간 조회는 봉 수 상한 적용 (1분봉 2,000 / 일봉 1,200 — `shared/src/horizon.ts`) |
| | D1 조회는 SQL `WHERE`·`LIMIT` 으로 자른다. JS 배열 필터링 금지 |
| | 각 엔드포인트가 `cpu` 이벤트를 구조화 로그로 남긴다 (`lib/logger.ts`) |
| D1 쓰기 10만 행/일 | 분봉 수집 대상 50종목 상한 (`cron/ingest.ts`) |
| KV 쓰기 1,000회/일 | KV 갱신은 Cron 에서만 수행 |

> **CPU 측정 주의** — Workers 런타임은 타이밍 사이드채널 대응으로 동기 연산 중 타이머를
> 진행시키지 않습니다. 로그의 `computeMs` 는 하한값이며, 권위 있는 값은 Workers Logs 의
> `cpuTime` 필드입니다(`[observability.logs]` 활성화됨). 8ms 초과 경로는 Cron 사전 계산으로
> 옮기십시오(§2.2-4).

---

## 안전장치 (§1.2) — 경고가 아니라 기능 차단

| # | 조건 | 동작 |
|---|---|---|
| S1 | 데이터가 지연·폴백 상태 | **가이드 생성 차단.** 차트만 표시 |
| S2 | 관리종목·거래정지·투자경고 | **가이드 생성 차단.** 사유 명시 |
| S2′ | 종목 상태 동기화 미완료 | **차단 (fail-closed).** 확인 불가 상태에서 가이드를 내지 않습니다 |
| S3 | 동일 signal_type 표본 30건 미만 | 신뢰도 **수치를 만들지 않음**. "검증 표본 부족" 표기 |
| S4 | 일평균 거래대금 30억 미만 | 슬리피지 경고 + 유동성 부족 배지 |
| S5 | 손익비 1.5 미만 | 가이드 미표시 |
| S6 | 상장 1년 미만 | 120/200 이평 미산출, 6개월·1년 기간 선택 차단 |
| S7 | 단일 종목 비중 20% 초과 | 모의투자 체결 시 경고 |

S2′ 는 명세에 없는 판단입니다. KRX 상태 동기화가 1회도 성공하지 않으면 `symbols.status` 가
`NULL` 로 남는데, 이때 "유의 종목이 아니다"라고 가정하면 실자금 참고 도구로서 위험이 큽니다.
따라서 **확인 불가 = 차단**으로 처리했습니다. KIS 전환 시 종목 상태를 API 가 직접 제공하므로
이 제약은 해소됩니다.

---

## API

모든 응답은 `{ ok: boolean, data?, error? }` 형식입니다.

```
GET    /health
GET    /api/symbols/search?q=&market=
GET    /api/symbols/:code
GET    /api/candles/:code?interval=&from=&to=&limit=
GET    /api/analysis/:code?horizon=&accountValue=&refresh=
GET    /api/market/regime
GET    /api/signals?code=&limit=
POST   /api/signals                      { code, horizon }
GET    /api/signals/stats?type=&days=
GET    /api/portfolios
POST   /api/portfolios                   { name, initialCash }
GET    /api/portfolios/:id
GET    /api/trades/estimate?code=&buyPrice=&sellPrice=&qty=
POST   /api/trades                       { portfolioId, code, side, price, qty, ... }
GET    /api/trades?portfolioId=
GET    /api/performance/:portfolioId?code=
GET|POST|DELETE /api/watchlist
GET|POST|DELETE /api/alerts
GET|POST|DELETE /api/events/:code

# GAS 릴레이 전용 — Access 제외 + Bearer 인증
GET    /internal/mail/pending?limit=
POST   /internal/mail/:id/sent
POST   /internal/mail/:id/failed         { reason }
```

---

## 구현 메모 (명세와 달라진 지점)

소스 제약이나 안전 판단으로 임의 결정한 부분입니다. 되돌릴 수 있도록 근거를 남깁니다.

1. **5분·30분봉은 1분봉 합성** — 네이버가 1분봉만 제공합니다
   (`providers/aggregate.ts`). KIS 전환 시 네이티브 봉으로 교체 가능합니다.
2. **검색 결과의 현재가는 D1 일봉 종가** — 검색 1회에 외부 호출 N건을 내지 않기 위함입니다.
   종목 상세(`/api/symbols/:code`)에서는 실시간 호가를 조회합니다.
3. **종목 상태 미동기화 시 차단(S2′)** — 위 표 참조.
4. **Buy&Hold 비교 기준 종목** — 포트폴리오에 여러 종목이 있을 때는 매수금액이 가장 큰
   종목을 기본값으로 쓰고, `?code=` 로 바꿀 수 있습니다.
5. **`migrations/0002_operational.sql`** — 명세 §4 외 운영 보조 테이블
   (`source_health`, `ingest_state`, `ingest_exclusion_log`)과 인덱스. 추가 사유를 각 객체에
   주석으로 남겼습니다. §4 원문 테이블은 그대로 둡니다.
6. **시그널 중복 방지** — 같은 종목·기간·유형은 KST 기준 하루 1건으로 제한합니다
   (`idx_signals_dedup`). 제한이 없으면 적중률 집계가 왜곡됩니다.
7. **`@cloudflare/vitest-pool-workers` 가 `@cloudflare/vitest-plugin` 으로 개명됨** —
   명세가 지정한 패키지를 유지하되, `/config` 서브패스가 사라져 `cloudflareTest` 플러그인
   API 를 사용합니다(`worker/vitest.config.ts`).
8. **이벤트(실적발표·배당락)는 수동 입력** — 안정적인 무료 공개 수집 소스를 확인하지
   못했습니다. 자동 수집 소스를 확보하면 `cron/` 에 추가하고 UI 는 그대로 두면 됩니다.

## 구현 범위

- Phase 1~3 (데이터 기반 · 분석과 검증 루프 · 모의투자) — 완료
- Phase 4 — KIS 어댑터는 뼈대까지(분봉 페이지네이션 `TODO`), F11(비교·관심종목·이벤트·
  리포트 내보내기)은 구현 완료

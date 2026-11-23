# Provider 전환 체크리스트 — 네이버 → 한국투자증권(KIS)

이 문서는 명세 §3·§9 Phase 4 의 "무중단 전환"을 수행하기 위한 절차서다.
전환의 전제는 **내부 표준 타입(§3.1)이 바뀌지 않는다**는 것이다. 어댑터만 교체하면
Worker 핸들러·분석 로직·프론트엔드는 한 줄도 고치지 않는다.

---

## 0. 먼저 알아야 할 것 — 현재 어댑터의 검증 상태

| 어댑터 | 파일 | 상태 |
|---|---|---|
| 네이버 | `worker/src/providers/naver.ts` | ⚠ **UNVERIFIED** — 실호출 검증 안 됨 |
| KRX | `worker/src/providers/krx.ts` | ⚠ **UNVERIFIED** — 실호출 검증 안 됨 |
| KIS | `worker/src/providers/kis.ts` | ⚠ **UNVERIFIED** + 분봉 페이지네이션 미구현 |
| mock | `worker/src/providers/mock.ts` | ✅ 결정론적, 단위 테스트 통과 |

이 코드베이스가 작성된 실행 환경은 네트워크 정책이 아래 호스트를 차단해
명세 §11("추측하지 말고 직접 호출하여 확인")을 만족시킬 수 없었다.

```
api.finance.naver.com:443     → 프록시 게이트웨이 403 (policy denial)
fchart.stock.naver.com:443    → 403
data.krx.co.kr                → 403
```

따라서 **운영 투입 전 반드시** 아래를 실행해 가설을 확정해야 한다.

```bash
npm run verify:provider                              # 전체
npx tsx scripts/verify-provider.ts --source naver --raw
npx tsx scripts/verify-provider.ts --source krx --raw
```

`--raw` 는 응답 앞 1,200자를 그대로 출력한다. 출력과 어긋나는 부분을 어댑터에서 고치고,
고친 뒤에는 해당 파일 상단의 `⚠ UNVERIFIED` 주석을 검증 일자로 교체한다.

> 가설이 틀려도 데이터가 조용히 유입되지는 않는다.
> `providers/schema.ts` 의 zod 검증이 예외를 던지고(§3.2-3),
> `lib/mail.ts` 의 `notifySourceFailure` 가 실패 URL·HTTP 상태·응답 앞 300자를 담아
> 관리자 메일을 큐에 넣는다(§8.1-2). 화면에는 S1 이 발동해 가이드가 차단된다.

---

## 1. KIS 전환 절차

### 1-1. 사전 준비
- [ ] 한국투자증권 계좌 개설 및 KIS Developers 앱키 발급 (실전/모의 도메인이 다름)
- [ ] `wrangler secret put KIS_APP_KEY`
- [ ] `wrangler secret put KIS_APP_SECRET`
- [ ] `wrangler.toml` 의 `[vars]` 에 `KIS_BASE_URL` 설정
      - 실전 `https://openapi.koreainvestment.com:9443`
      - 모의 `https://openapivts.koreainvestment.com:29443`

### 1-2. 어댑터 검증
- [ ] 접근토큰(`/oauth2/tokenP`) 발급 성공 — **1일 1회 발급 제한**이 있으므로 KV 캐시가 반드시 동작해야 한다
- [ ] 일봉 `FHKST03010100` — `output2` 필드명(`stck_bsop_date`, `stck_oprc`, `stck_hgpr`, `stck_lwpr`, `stck_clpr`, `acml_vol`, `acml_tr_pbmn`) 확인
- [ ] 분봉 `FHKST03010200` — **1회 조회당 30건 제한**. `FID_INPUT_HOUR_1` 을 역방향으로 이동시키는 페이지네이션 구현 (`kis.ts` 의 `TODO(Phase 4)`)
- [ ] 현재가 `FHKST01010100` — `stck_prpr`, `prdy_vrss`, `prdy_ctrt`
- [ ] 유통 제한(초당 호출 수) 확인 후 `kis.ts` 의 `RateLimiter(10, 10)` 조정
- [ ] 종목 상태(관리종목·거래정지) 필드 확인 → **S2 의 `status === null` 차단을 해소할 수 있는 핵심 항목**

### 1-3. 수정주가 정합성 (§3.3) — 가장 위험한 단계

네이버와 KIS 는 수정주가 처리가 다를 수 있다. `candles.adj` 컬럼에 반영 여부가 기록되어 있다.

- [ ] 액면분할·무상증자 이력이 있는 종목을 표본으로 뽑는다
      ```sql
      SELECT code, date, kind FROM events WHERE kind = 'SPLIT';
      ```
- [ ] 동일 구간을 두 소스에서 조회해 종가를 대조한다
- [ ] 괴리가 있으면 **해당 종목 구간을 삭제 후 재적재**한다

재적재 스크립트(아래)는 `wrangler d1 execute` 로 실행한다.

```sql
-- migrations 가 아니라 1회성 운영 쿼리로 실행한다.
-- 1) 대상 구간 삭제
DELETE FROM candles
 WHERE code = '005930'
   AND interval IN ('1d','1w','1M')
   AND t >= strftime('%s','2018-01-01') * 1000;

-- 2) ingest_state 를 지워 다음 Cron 이 전 구간을 다시 가져오게 한다
DELETE FROM ingest_state WHERE code = '005930';

-- 3) 해당 종목의 분석 캐시 무효화
DELETE FROM analysis_cache WHERE cache_key LIKE '005930:%';
```

재적재 후 검증:

```sql
SELECT interval, COUNT(*) AS n, MIN(adj) AS min_adj, MAX(adj) AS max_adj
  FROM candles WHERE code = '005930' GROUP BY interval;
```

`min_adj = max_adj = 1` 이어야 한다. 섞여 있으면 구간이 덜 지워진 것이다.

> ⚠ **시그널 이력은 재적재하지 않는다.** `signals.indicators` 는 생성 시점의 지표를
> 박제한 값이며, 사후에 바꾸면 F9 적중률이 왜곡된다. 수정주가 변경 구간의 시그널은
> 채점 대상에서 제외할지 여부를 별도로 판단하라.

### 1-4. 전환 실행
- [ ] `wrangler.toml` → `PRICE_PROVIDER = "kis"`
- [ ] `npx wrangler deploy`
- [ ] `/health` 의 `provider` 가 `kis` 인지 확인
- [ ] 임의 종목 `/api/candles/005930?interval=1d` 호출 → 200 + 정상 건수
- [ ] Workers Logs 에서 `upstream_fetch` 의 `source: "kis"` 확인
- [ ] 하루 운영 후 `source_health` 테이블에서 `fail_streak = 0` 확인

### 1-5. 롤백
`PRICE_PROVIDER = "naver"` 로 되돌리고 재배포한다. D1 에 적재된 캔들은 정규화 포맷이라
소스와 무관하게 그대로 쓸 수 있으므로 데이터 손실은 없다. 단, `adj` 가 섞였다면
1-3 의 재적재를 다시 수행해야 한다.

---

## 2. 세율 검증 (§11)

`worker/src/analysis/cost.ts` 의 `TAX_RATE_VERIFIED_AT` 이 `null` 이면 **미검증 상태**다.

검증 대상과 1차 출처:

| 항목 | 현재 값 | 확인처 |
|---|---|---|
| 코스피 매도 세금 | 0.15% | 증권거래세법 + 농어촌특별세법 (국가법령정보센터) |
| 코스닥 매도 세금 | 0.15% | 증권거래세법 |
| 국내 주식형 ETF·ETN | 0% | 증권거래세법 비과세 조항 |
| 매매수수료 | 0.015% | 이용 중인 증권사 수수료표 |

확인 후:
1. `COST.sellTaxRateByMarket` 값을 갱신한다.
2. `TAX_RATE_VERIFIED_AT` 에 확인 일자(`"YYYY-MM-DD"`)를 기입한다.
3. 출처 URL 을 주석으로 남긴다.
4. `worker/test/cost.test.ts` 의 기대값을 함께 갱신한다 — 테스트가 깨지면 반영된 것이다.

---

## 3. 새 Provider 추가 시 체크리스트

1. `worker/src/providers/<name>.ts` 에 `PriceProvider` 를 구현한다.
2. **원본 필드명이 이 파일을 벗어나지 않는지** 확인한다(§3.2-1).
   ```bash
   grep -rn "stck_\|ISU_\|closePrice" worker/src --include=*.ts | grep -v "src/providers/"
   # → 아무것도 나오지 않아야 한다
   ```
3. 반환 전 `validateCandles()` 를 호출한다(§3.2-3).
4. `providers/index.ts` 의 `getProvider()` 에 분기를 추가한다.
5. `scripts/verify-provider.ts` 에 검증 함수를 추가한다.
6. 레이트 리미터 상한을 소스 정책에 맞춰 설정한다(§8.1-4).

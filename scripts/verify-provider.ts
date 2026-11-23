/**
 * 외부 소스 응답 구조 검증 하네스.
 *
 * 이 코드베이스가 작성된 실행 환경은 네트워크 정책이 네이버·KRX 도메인을 차단해
 * 명세 §11("추측하지 말고 직접 호출하여 확인")을 만족시킬 수 없었다.
 * 따라서 어댑터의 파싱 규칙은 **가설(UNVERIFIED)** 이며, 이 스크립트를 당신의 로컬
 * 네트워크에서 실행해 실제 응답과 대조한 뒤 어댑터를 확정해야 한다.
 *
 *   npm run verify:provider              # 전체
 *   npx tsx scripts/verify-provider.ts --source naver --code 005930
 *   npx tsx scripts/verify-provider.ts --source krx --raw
 *
 * --raw 를 주면 응답 앞 1,200자를 그대로 출력한다. 어댑터 수정 시 이 출력을 근거로 삼는다.
 */

import { __naverInternals } from "../worker/src/providers/naver.js";

const { parseJsArrayLiteral, parseYmdToKstEpoch, parseYmdHmToKstEpoch, num, findCol } = __naverInternals;

type Args = { source: string; code: string; raw: boolean };

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string): string => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
  };
  return { source: get("source", "all"), code: get("code", "005930"), raw: argv.includes("--raw") };
}

const UA = "Mozilla/5.0 (compatible; kr-stock-advisor-verify/0.1)";
const ymd = (d: Date): string => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`;
};

let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, ...init });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    // 네트워크 차단·DNS 실패도 '검증 실패'로 보고하고 계속 진행한다.
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
    return { status: 0, body: `네트워크 오류: ${String(e)}${cause ? ` (${cause})` : ""}` };
  }
}

/* ───────────── 네이버 ───────────── */

async function verifyNaverDaily(code: string, raw: boolean): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 86_400_000);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${ymd(from)}&endTime=${ymd(to)}&timeframe=day`;
  console.log(`\n[naver 일봉] ${url}`);
  const { status, body } = await get(url, { Referer: "https://finance.naver.com/" });
  report("HTTP 200", status === 200, status === 0 ? body.slice(0, 160) : `status=${status}`);
  if (raw) console.log(`  ---\n${body.slice(0, 1200)}\n  ---`);
  if (status !== 200) return;

  try {
    const rows = parseJsArrayLiteral(body, url);
    report("배열 리터럴 파싱", rows.length >= 2, `${rows.length}행`);
    const header = (rows[0] ?? []).map(String);
    console.log(`  헤더: ${header.join(" | ")}`);
    for (const col of ["날짜", "시가", "고가", "저가", "종가", "거래량"]) {
      report(`헤더에 '${col}' 존재`, findCol(header, [col]) >= 0, "");
    }
    const sample = rows[1] ?? [];
    report("날짜가 YYYYMMDD", parseYmdToKstEpoch(String(sample[0] ?? "")) !== null, String(sample[0]));
    report("종가가 숫자", num(sample[4]) !== null, String(sample[4]));
  } catch (e) {
    report("파싱", false, String(e));
  }
}

async function verifyNaverMinute(code: string, raw: boolean): Promise<void> {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=minute&count=20&requestType=0`;
  console.log(`\n[naver 분봉] ${url}`);
  const { status, body } = await get(url, { Referer: "https://finance.naver.com/" });
  report("HTTP 200", status === 200, status === 0 ? body.slice(0, 160) : `status=${status}`);
  if (raw) console.log(`  ---\n${body.slice(0, 1200)}\n  ---`);
  if (status !== 200) return;

  const items = [...body.matchAll(/data="([^"]+)"/g)].map((m) => m[1]!);
  report('item[data] 노드 존재', items.length > 0, `${items.length}건`);
  if (items.length === 0) return;
  const parts = items[0]!.split("|");
  console.log(`  샘플: ${items[0]}`);
  report("필드 6개 이상 (일시|시|고|저|종|거래량)", parts.length >= 6, `${parts.length}개`);
  report("일시가 YYYYMMDDHHmm", parseYmdHmToKstEpoch(parts[0] ?? "") !== null, parts[0] ?? "");
}

async function verifyNaverQuote(code: string, raw: boolean): Promise<void> {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
  console.log(`\n[naver 현재가] ${url}`);
  const { status, body } = await get(url, { Referer: "https://finance.naver.com/" });
  report("HTTP 200", status === 200, status === 0 ? body.slice(0, 160) : `status=${status}`);
  if (raw) console.log(`  ---\n${body.slice(0, 1200)}\n  ---`);
  if (status !== 200) return;
  try {
    const json = JSON.parse(body) as { datas?: Record<string, unknown>[] };
    report("datas 배열 존재", Array.isArray(json.datas) && json.datas.length > 0, "");
    const d = json.datas?.[0] ?? {};
    console.log(`  키: ${Object.keys(d).slice(0, 20).join(", ")}`);
    for (const key of ["closePrice", "compareToPreviousClosePrice", "fluctuationsRatio"]) {
      report(`필드 '${key}' 존재`, key in d, String(d[key] ?? ""));
    }
  } catch (e) {
    report("JSON 파싱", false, String(e));
  }
}

/* ───────────── KRX ───────────── */

const KRX_ENDPOINT = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const KRX_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Referer: "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader",
  "X-Requested-With": "XMLHttpRequest",
};

async function verifyKrx(bld: string, params: Record<string, string>, expectKeys: string[], raw: boolean): Promise<void> {
  console.log(`\n[krx] ${bld}`);
  const { status, body } = await get(KRX_ENDPOINT, KRX_HEADERS, {
    method: "POST", body: new URLSearchParams({ bld, ...params }).toString(),
  });
  report("HTTP 200", status === 200, status === 0 ? body.slice(0, 160) : `status=${status}`);
  if (raw) console.log(`  ---\n${body.slice(0, 1200)}\n  ---`);
  if (status !== 200) return;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    console.log(`  최상위 키: ${Object.keys(json).join(", ")}`);
    const rows = (json["OutBlock_1"] ?? json["output"] ?? json["block1"]) as unknown;
    report("결과 배열 존재", Array.isArray(rows), "");
    if (!Array.isArray(rows) || rows.length === 0) { report("0건 아님", false, ""); return; }
    const r = rows[0] as Record<string, unknown>;
    console.log(`  필드: ${Object.keys(r).slice(0, 25).join(", ")}`);
    for (const key of expectKeys) report(`필드 '${key}' 존재`, key in r, String(r[key] ?? ""));
  } catch (e) {
    report("JSON 파싱", false, String(e));
  }
}

/* ───────────── 실행 ───────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`소스 검증 시작 — source=${args.source} code=${args.code}\n`
    + "이 스크립트의 결과와 어긋나는 어댑터 코드는 즉시 수정하십시오.\n"
    + "worker/src/providers/{naver,krx}.ts 의 UNVERIFIED 주석도 함께 갱신하십시오.");

  if (args.source === "all" || args.source === "naver") {
    await verifyNaverDaily(args.code, args.raw);
    await verifyNaverMinute(args.code, args.raw);
    await verifyNaverQuote(args.code, args.raw);
  }
  if (args.source === "all" || args.source === "krx") {
    await verifyKrx("dbms/MDC/STAT/standard/MDCSTAT01901",
      { mktId: "ALL", share: "1", csvxls_isNo: "false" },
      ["ISU_SRT_CD", "ISU_ABBRV", "MKT_TP_NM", "LIST_DD"], args.raw);
    await verifyKrx("dbms/MDC/STAT/standard/MDCSTAT01501",
      { mktId: "ALL", trdDd: ymd(new Date(Date.now() - 86_400_000)), share: "1", money: "1", csvxls_isNo: "false" },
      ["ISU_SRT_CD", "TDD_CLSPRC", "ACC_TRDVAL"], args.raw);
  }

  console.log(`\n${failures === 0 ? "✅ 모든 항목 통과 — 어댑터 가설이 실제 응답과 일치합니다." : `❌ 실패 ${failures}건 — 어댑터를 수정해야 합니다.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

import { describe, expect, it } from "vitest";
import type { Candle } from "@app/shared";
import { SchemaError, validateCandles } from "../src/providers/schema.js";
import { __naverInternals } from "../src/providers/naver.js";
import { resampleDaily, resampleMinutes } from "../src/providers/aggregate.js";
import { mockCandles } from "../src/providers/mock.js";
import { filterMaster, type MasterDoc } from "../src/providers/master.js";
import { delayMinutes, fromKstDate, isRegularSession, kstDate, kstYmd, kstMidnight } from "../src/lib/time.js";
import { parseStatus } from "../src/cron/symbols.js";

const { parseJsArrayLiteral, parseYmdToKstEpoch, parseYmdHmToKstEpoch, num, findCol } = __naverInternals;

describe("네이버 응답 파싱", () => {
  it("작은따옴표 JS 배열 리터럴을 파싱한다", () => {
    const body = `[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
['20250102', 53400, 53900, 53000, 53600, 12345678, 50.12],
['20250103', 53600, 54500, 53500, 54400, 9876543, 50.20]]`;
    const rows = parseJsArrayLiteral(body, "test");
    expect(rows).toHaveLength(3);
    expect(rows[1]![0]).toBe("20250102");
    expect(rows[2]![4]).toBe(54400);
  });

  it("후행 쉼표를 허용한다", () => {
    expect(parseJsArrayLiteral("[['a'],['b'],]", "test")).toHaveLength(2);
  });

  it("파싱 실패 시 SchemaError 를 던진다 (조용히 넘어가지 않는다)", () => {
    expect(() => parseJsArrayLiteral("<html>503</html>", "test")).toThrow(SchemaError);
  });

  it("헤더 컬럼을 공백 무시로 찾는다", () => {
    expect(findCol(["날 짜", "시가", "종가"], ["날짜"])).toBe(0);
    expect(findCol(["날짜", "시가"], ["거래량"])).toBe(-1);
  });

  it("쉼표·단위가 섞인 숫자를 변환한다", () => {
    expect(num("79,600")).toBe(79600);
    expect(num("0.76")).toBe(0.76);
    expect(num("-")).toBeNull();
    expect(num("")).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num(1234)).toBe(1234);
  });

  it("KST 날짜·시각을 epoch ms 로 변환한다", () => {
    const t = parseYmdToKstEpoch("20250102")!;
    expect(kstDate(t)).toBe("2025-01-02");
    const tm = parseYmdHmToKstEpoch("202501020901")!;
    expect(new Date(tm + 9 * 3600_000).toISOString()).toBe("2025-01-02T09:01:00.000Z");
    expect(parseYmdToKstEpoch("2025-01-02")).toBeNull();
  });
});

describe("validateCandles (§3.2-3)", () => {
  const mk = (t: number, c = 100): Candle => ({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 10, adj: true });

  it("정상 데이터는 통과한다", () => {
    expect(validateCandles("x", "u", [mk(1000), mk(2000)])).toHaveLength(2);
  });

  it("시간 역순이면 거부한다", () => {
    expect(() => validateCandles("x", "u", [mk(2000), mk(1000)])).toThrow(/시간 정렬 위반/);
  });

  it("중복 시각도 거부한다", () => {
    expect(() => validateCandles("x", "u", [mk(1000), mk(1000)])).toThrow(/시간 정렬 위반/);
  });

  it("건수가 모자라면 거부한다", () => {
    expect(() => validateCandles("x", "u", [], { minCount: 1 })).toThrow(/건수 부족/);
  });

  it("OHLC 정합성을 검사한다", () => {
    expect(() => validateCandles("x", "u", [{ t: 1, o: 100, h: 90, l: 95, c: 98, v: 1, adj: true }]))
      .toThrow(/OHLC 정합성 위반/);
  });

  it("타입이 틀리면 거부한다", () => {
    expect(() => validateCandles("x", "u", [{ t: 1, o: "100", h: 101, l: 99, c: 100, v: 1, adj: true }]))
      .toThrow(SchemaError);
  });
});

describe("리샘플링", () => {
  it("1분봉 5개를 5분봉 1개로 합성한다", () => {
    const base = fromKstDate("2025-01-02") + 9 * 3600_000;   // 09:00 KST
    const ones: Candle[] = Array.from({ length: 5 }, (_, i) => ({
      t: base + i * 60_000, o: 100 + i, h: 105 + i, l: 95 + i, c: 101 + i, v: 10, va: 1000, adj: true,
    }));
    const out = resampleMinutes(ones, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.o).toBe(100);
    expect(out[0]!.c).toBe(105);
    expect(out[0]!.h).toBe(109);
    expect(out[0]!.l).toBe(95);
    expect(out[0]!.v).toBe(50);
  });

  it("세션(날짜) 경계를 넘어 합쳐지지 않는다", () => {
    const d1 = fromKstDate("2025-01-02") + 15 * 3600_000 + 29 * 60_000;  // 15:29
    const d2 = fromKstDate("2025-01-03") + 9 * 3600_000;                 // 익일 09:00
    const out = resampleMinutes([
      { t: d1, o: 1, h: 1, l: 1, c: 1, v: 1, adj: true },
      { t: d2, o: 2, h: 2, l: 2, c: 2, v: 1, adj: true },
    ], 30);
    expect(out).toHaveLength(2);
  });

  it("일봉을 주봉(월요일 시작)으로 합성한다", () => {
    // 2025-01-06(월) ~ 2025-01-10(금) → 1개 주봉
    const days = ["2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10"].map((d, i) => ({
      t: fromKstDate(d), o: 100, h: 110 + i, l: 90 - i, c: 100 + i, v: 10, adj: true,
    }));
    const out = resampleDaily(days, "1w");
    expect(out).toHaveLength(1);
    expect(kstDate(out[0]!.t)).toBe("2025-01-06");
    expect(out[0]!.h).toBe(114);
    expect(out[0]!.l).toBe(86);
    expect(out[0]!.c).toBe(104);
  });

  it("일봉을 월봉으로 합성한다", () => {
    const days = ["2025-01-06", "2025-01-20", "2025-02-03"].map((d) => ({
      t: fromKstDate(d), o: 100, h: 110, l: 90, c: 100, v: 10, adj: true,
    }));
    expect(resampleDaily(days, "1M")).toHaveLength(2);
  });
});

describe("mock provider", () => {
  it("동일 입력에 대해 결정론적이다", () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 2, 1));
    const a = mockCandles("005930", "1d", from, to);
    const b = mockCandles("005930", "1d", from, to);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
  it("종목이 다르면 다른 시계열을 만든다", () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 2, 1));
    expect(mockCandles("005930", "1d", from, to)[0]!.c).not.toBe(mockCandles("000660", "1d", from, to)[0]!.c);
  });
});

describe("종목마스터 검색 (§3.4)", () => {
  const doc: MasterDoc = {
    updatedAt: 0, count: 4,
    entries: [
      { code: "005930", name: "삼성전자", market: "KOSPI", listedAt: null, avgTradingValue: null, status: [] },
      { code: "005935", name: "삼성전자우", market: "KOSPI", listedAt: null, avgTradingValue: null, status: [] },
      { code: "000660", name: "SK하이닉스", market: "KOSPI", listedAt: null, avgTradingValue: null, status: [] },
      { code: "035720", name: "카카오", market: "KOSDAQ", listedAt: null, avgTradingValue: null, status: null },
    ],
  };
  it("종목코드 완전일치를 최우선으로 돌려준다", () => {
    expect(filterMaster(doc, "005930")[0]!.code).toBe("005930");
  });
  it("종목명 부분일치", () => {
    expect(filterMaster(doc, "삼성").map((e) => e.code)).toEqual(["005930", "005935"]);
  });
  it("시장구분 필터", () => {
    expect(filterMaster(doc, "카카오", "KOSPI")).toHaveLength(0);
    expect(filterMaster(doc, "카카오", "KOSDAQ")).toHaveLength(1);
  });
  it("빈 검색어는 빈 결과", () => {
    expect(filterMaster(doc, "   ")).toEqual([]);
  });
});

describe("KST 시간 유틸 (§8.2)", () => {
  it("UTC 자정 직전도 KST 로는 다음 날", () => {
    const t = Date.UTC(2025, 0, 1, 15, 30);      // 2025-01-02 00:30 KST
    expect(kstDate(t)).toBe("2025-01-02");
    expect(kstYmd(t)).toBe("20250102");
  });
  it("kstMidnight 는 KST 자정으로 내림한다", () => {
    expect(kstDate(kstMidnight(Date.UTC(2025, 0, 2, 5, 0)))).toBe("2025-01-02");
  });
  it("정규장 판정 (평일 09:00~15:30 KST)", () => {
    expect(isRegularSession(Date.UTC(2025, 0, 2, 1, 0))).toBe(true);    // 목 10:00 KST
    expect(isRegularSession(Date.UTC(2025, 0, 2, 7, 0))).toBe(false);   // 목 16:00 KST
    expect(isRegularSession(Date.UTC(2025, 0, 4, 2, 0))).toBe(false);   // 토요일
  });
  it("장외 시간에는 지연 분을 산출하지 않는다", () => {
    expect(delayMinutes(Date.UTC(2025, 0, 2, 7, 0), Date.UTC(2025, 0, 2, 6, 0))).toBeNull();
    expect(delayMinutes(Date.UTC(2025, 0, 2, 1, 0), Date.UTC(2025, 0, 2, 0, 30))).toBe(30);
    expect(delayMinutes(Date.UTC(2025, 0, 2, 1, 0), null)).toBeNull();
  });
});

describe("종목 상태 파싱 (S2)", () => {
  it("차단 사유만 추출한다", () => {
    expect(parseStatus("관리종목")).toEqual(["관리종목"]);
    expect(parseStatus("투자경고 / 거래정지")).toEqual(expect.arrayContaining(["거래정지", "투자경고"]));
    expect(parseStatus("")).toEqual([]);
    expect(parseStatus("정상")).toEqual([]);
  });
});

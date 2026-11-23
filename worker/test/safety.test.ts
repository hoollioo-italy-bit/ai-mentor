import { describe, expect, it } from "vitest";
import { HORIZON_CONFIG, MIN_SAMPLE, type Freshness, type SignalStat } from "@app/shared";
import { checkConcentration, evaluateSafety, isBlocked, isYoung } from "../src/analysis/safety.js";
import { toConfidence } from "../src/analysis/guide.js";

const NOW = Date.UTC(2026, 10, 23, 5, 0, 0);   // 2026-11-23 14:00 KST (장중 월요일)

const live: Freshness = { state: "LIVE", source: "naver", lastBarAt: NOW - 60_000, fetchedAt: NOW, delayMinutes: 1 };

const base = {
  freshness: live,
  status: [] as string[] | null,
  sample: 100,
  avgTradingValue: 50_000_000_000,
  riskReward: 2.0 as number | null,
  listedAt: "2015-01-02" as string | null,
  config: HORIZON_CONFIG["1m"],
  now: NOW,
};

describe("S1 데이터 지연·폴백", () => {
  it("폴백 소스면 차단", () => {
    const f = evaluateSafety({ ...base, freshness: { ...live, state: "FALLBACK", source: "krx" } });
    expect(f.find((x) => x.code === "S1")?.blocking).toBe(true);
  });
  it("캐시까지 내려가면 차단", () => {
    const f = evaluateSafety({ ...base, freshness: { ...live, state: "STALE", source: "cache(D1)" } });
    expect(isBlocked(f)).toBe(true);
  });
  it("장중 20분 초과 지연이면 차단", () => {
    const f = evaluateSafety({ ...base, freshness: { ...live, delayMinutes: 25 } });
    expect(f.find((x) => x.code === "S1")?.blocking).toBe(true);
  });
  it("정상 실시간이면 S1 없음", () => {
    expect(evaluateSafety(base).some((x) => x.code === "S1")).toBe(false);
  });
});

describe("S2 거래 유의 종목", () => {
  it("관리종목이면 차단", () => {
    const f = evaluateSafety({ ...base, status: ["관리종목"] });
    const s2 = f.find((x) => x.code === "S2");
    expect(s2?.blocking).toBe(true);
    expect(s2?.reason).toContain("관리종목");
  });
  it("상태를 확인할 수 없으면(동기화 미완료) 차단한다 — fail closed", () => {
    const f = evaluateSafety({ ...base, status: null });
    expect(f.find((x) => x.code === "S2")?.blocking).toBe(true);
  });
  it("상태가 비어 있으면(동기화 완료·사유 없음) 통과", () => {
    expect(evaluateSafety({ ...base, status: [] }).some((x) => x.code === "S2")).toBe(false);
  });
});

describe("S3 표본 부족", () => {
  it("30건 미만이면 비차단 경고", () => {
    const f = evaluateSafety({ ...base, sample: MIN_SAMPLE - 1 });
    const s3 = f.find((x) => x.code === "S3");
    expect(s3).toBeDefined();
    expect(s3?.blocking).toBe(false);
  });
  it("신뢰도 수치를 만들지 않는다", () => {
    const stat: SignalStat = {
      signalType: "GOLDEN_CROSS", label: "골든크로스", horizonDays: 20,
      sample: 29, hitRate: null, avgReturn: null, stopRate: null, insufficient: true,
    };
    const c = toConfidence(stat);
    expect(c.available).toBe(false);
    expect(c).not.toHaveProperty("hitRate");
  });
  it("30건 이상이면 수치를 제공한다", () => {
    const stat: SignalStat = {
      signalType: "GOLDEN_CROSS", label: "골든크로스", horizonDays: 20,
      sample: 42, hitRate: 0.55, avgReturn: 0.012, stopRate: 0.3, insufficient: false,
    };
    const c = toConfidence(stat);
    expect(c.available).toBe(true);
    if (c.available) expect(c.hitRate).toBe(0.55);
  });
});

describe("S4 유동성", () => {
  it("일평균 거래대금 30억 미만이면 경고(비차단)", () => {
    const f = evaluateSafety({ ...base, avgTradingValue: 2_900_000_000 });
    expect(f.find((x) => x.code === "S4")?.blocking).toBe(false);
  });
  it("30억 이상이면 경고 없음", () => {
    expect(evaluateSafety({ ...base, avgTradingValue: 3_000_000_000 }).some((x) => x.code === "S4")).toBe(false);
  });
});

describe("S5 손익비", () => {
  it("1.5 미만이면 차단", () => {
    expect(evaluateSafety({ ...base, riskReward: 1.49 }).find((x) => x.code === "S5")?.blocking).toBe(true);
  });
  it("1.5 이상이면 통과", () => {
    expect(evaluateSafety({ ...base, riskReward: 1.5 }).some((x) => x.code === "S5")).toBe(false);
  });
});

describe("S6 상장 1년 미만", () => {
  it("1년 미만 판정", () => {
    expect(isYoung("2026-06-01", NOW)).toBe(true);
    expect(isYoung("2020-01-02", NOW)).toBe(false);
    expect(isYoung(null, NOW)).toBe(false);
  });
  it("장기 지표가 필요한 기간(1y)은 차단한다", () => {
    const f = evaluateSafety({ ...base, listedAt: "2026-06-01", config: HORIZON_CONFIG["1y"] });
    expect(f.find((x) => x.code === "S6")?.blocking).toBe(true);
  });
  it("단기 기간(1m)은 경고만 띄운다", () => {
    const f = evaluateSafety({ ...base, listedAt: "2026-06-01", config: HORIZON_CONFIG["1m"] });
    expect(f.find((x) => x.code === "S6")?.blocking).toBe(false);
  });
});

describe("S7 단일 종목 비중", () => {
  it("20% 초과면 경고", () => {
    const flag = checkConcentration(21, 100);
    expect(flag?.code).toBe("S7");
    expect(flag?.blocking).toBe(false);
  });
  it("20% 이하면 경고 없음", () => {
    expect(checkConcentration(20, 100)).toBeNull();
  });
  it("총액이 0이면 판정하지 않는다", () => {
    expect(checkConcentration(10, 0)).toBeNull();
  });
});

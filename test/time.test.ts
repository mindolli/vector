import { test } from "node:test";
import assert from "node:assert/strict";
import { kstDayRange, toKst } from "../src/time.ts";

test("toKst: Unix ms 를 +09:00 문자열로 바꾼다", () => {
  assert.equal(toKst(1790000000000), "2026-09-21T23:13:20+09:00");
  // UTC 15:00 은 KST 다음 날 00:00
  assert.equal(toKst(Date.UTC(2026, 8, 25, 15, 0, 0)), "2026-09-26T00:00:00+09:00");
});

test("kstDayRange: KST 하루의 시작과 끝", () => {
  const r = kstDayRange("2026-09-26");
  assert.ok(r);
  assert.equal(new Date(r.start).toISOString(), "2026-09-25T15:00:00.000Z");
  assert.equal(new Date(r.end).toISOString(), "2026-09-26T14:59:59.999Z");
});

test("kstDayRange: 경계값은 양 끝을 포함한다", () => {
  const r = kstDayRange("2026-09-26")!;
  const midnightKst = Date.UTC(2026, 8, 25, 15, 0, 0);
  assert.ok(midnightKst >= r.start && midnightKst <= r.end);
  assert.ok(midnightKst - 1 < r.start); // 전날 KST 23:59:59.999 는 제외
});

test("kstDayRange: 연말과 윤년", () => {
  assert.equal(new Date(kstDayRange("2027-01-01")!.start).toISOString(), "2026-12-31T15:00:00.000Z");
  assert.ok(kstDayRange("2028-02-29")); // 윤년
  assert.equal(kstDayRange("2026-02-29"), null); // 평년
});

test("kstDayRange: 잘못된 입력은 null", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-9-26", "20260926", "", "2026-09-26T00:00"]) {
    assert.equal(kstDayRange(bad), null, bad);
  }
});

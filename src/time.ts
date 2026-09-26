// Workers 런타임은 항상 UTC 로 동작한다. D1 에는 시간대와 무관한 Unix ms 를 저장하고,
// API 입출력에서만 KST(UTC+9, 서머타임 없음)로 변환한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Unix ms → "2026-09-21T23:13:20+09:00" (초 단위까지) */
export function toKst(ms: number): string {
  // ms 에 9시간을 더한 시각의 UTC 표기 = KST 벽시계 시각
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 19) + "+09:00";
}

/**
 * "YYYY-MM-DD" 를 KST 하루의 [start, end] (Unix ms, 양 끝 포함)로 바꾼다.
 * 형식이 틀리거나 존재하지 않는 날짜(예: 2026-02-30)이면 null.
 */
export function kstDayRange(date: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];

  const utcMidnight = Date.UTC(y, mo - 1, d);
  // Date.UTC 는 2월 30일을 3월 2일로 넘겨 버리므로, 되돌려서 같은 날짜인지 확인한다.
  if (new Date(utcMidnight).toISOString().slice(0, 10) !== date) return null;

  const start = utcMidnight - KST_OFFSET_MS;
  return { start, end: start + DAY_MS - 1 };
}

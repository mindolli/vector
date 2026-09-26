import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, normalizeUrl, truncate, validateBookmarkInput } from "../src/routes.ts";

test("validateBookmarkInput: 정상 입력은 공백을 정리하고 URL 을 정규화한다", () => {
  const r = validateBookmarkInput({ url: "  HTTPS://Example.com  ", title: "  제목 ", memo: "메모" });
  assert.deepEqual(r, {
    ok: true,
    value: { url: "https://example.com/", title: "제목", description: "", content: "", memo: "메모" },
  });
});

test("validateBookmarkInput: url 이 없거나 문자열이 아니면 거부", () => {
  assert.deepEqual(validateBookmarkInput({}), { ok: false, error: "url is required" });
  assert.deepEqual(validateBookmarkInput({ url: "" }), { ok: false, error: "url is required" });
  assert.deepEqual(validateBookmarkInput({ url: 123 }), { ok: false, error: "url must be a string" });
  assert.deepEqual(validateBookmarkInput({ url: "https://a.test", memo: ["x"] }), { ok: false, error: "memo must be a string" });
});

test("validateBookmarkInput: 객체가 아닌 본문은 거부", () => {
  for (const body of [null, [], "text", 42]) {
    assert.equal(validateBookmarkInput(body).ok, false, JSON.stringify(body));
  }
});

test("validateBookmarkInput: 긴 필드는 제한 길이로 자른다", () => {
  const r = validateBookmarkInput({ url: "https://a.test", content: "가".repeat(3000), title: "t".repeat(600) });
  assert.ok(r.ok);
  assert.equal([...r.value.content].length, LIMITS.content);
  assert.equal(r.value.title.length, LIMITS.title);
});

test("normalizeUrl: http/https 만 허용", () => {
  for (const bad of ["javascript:alert(1)", "ftp://a.test", "file:///etc/passwd", "a.test", "not a url"]) {
    assert.equal(normalizeUrl(bad).ok, false, bad);
  }
  assert.deepEqual(normalizeUrl("http://a.test/path?x=1#h"), { ok: true, value: "http://a.test/path?x=1#h" });
});

test("normalizeUrl: 너무 긴 URL 은 자르지 않고 거부", () => {
  const long = "https://a.test/" + "x".repeat(LIMITS.url);
  assert.equal(normalizeUrl(long).ok, false);
});

test("normalizeUrl: 저장과 조회가 같은 값을 만든다 (중복 판정)", () => {
  const a = normalizeUrl("https://Example.com");
  const b = normalizeUrl("https://example.com/");
  assert.ok(a.ok && b.ok);
  assert.equal(a.value, b.value);
});

test("truncate: 이모지를 반으로 자르지 않는다", () => {
  const s = "ab😀cd";
  assert.equal(truncate(s, 3), "ab😀");
  assert.equal("ab😀cd".slice(0, 3), "ab\ud83d"); // slice 는 서로게이트 쌍을 끊어 버린다
  assert.equal(truncate("짧음", 10), "짧음");
});

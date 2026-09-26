import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorized, timingSafeEqual } from "../src/auth.ts";

const TOKEN = "test-token-1234";
const req = (authorization?: string) =>
  new Request("https://example.test/api/bookmarks", {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });

test("isAuthorized: 올바른 Bearer 토큰은 통과", async () => {
  assert.equal(await isAuthorized(req(`Bearer ${TOKEN}`), TOKEN), true);
});

test("isAuthorized: 틀리거나 형식이 다르면 거부", async () => {
  for (const h of [undefined, "", "Bearer", "Bearer ", `bearer ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
    assert.equal(await isAuthorized(req(h), TOKEN), false, String(h));
  }
});

test("isAuthorized: 서버에 토큰이 설정되지 않았으면 항상 거부", async () => {
  assert.equal(await isAuthorized(req("Bearer "), ""), false);
  assert.equal(await isAuthorized(req("Bearer anything"), undefined), false);
});

test("timingSafeEqual: 길이가 달라도 올바르게 비교", async () => {
  assert.equal(await timingSafeEqual("abc", "abc"), true);
  assert.equal(await timingSafeEqual("abc", "abcd"), false);
  assert.equal(await timingSafeEqual("한글토큰", "한글토큰"), true);
});

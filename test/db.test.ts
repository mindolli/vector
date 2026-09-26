import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLike } from "../src/db.ts";

test("escapeLike: 앞뒤에 % 를 붙인다", () => {
  assert.equal(escapeLike("벡터"), "%벡터%");
});

test("escapeLike: LIKE 특수 문자는 문자 그대로 찾도록 이스케이프", () => {
  assert.equal(escapeLike("100%"), "%100\\%%");
  assert.equal(escapeLike("snake_case"), "%snake\\_case%");
  assert.equal(escapeLike("C:\\path"), "%C:\\\\path%");
});

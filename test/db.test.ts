import { test } from "node:test";
import assert from "node:assert/strict";
import { blobToFloat32, escapeLike, float32ToBlob } from "../src/db.ts";

test("escapeLike: 앞뒤에 % 를 붙인다", () => {
  assert.equal(escapeLike("벡터"), "%벡터%");
});

test("escapeLike: LIKE 특수 문자는 문자 그대로 찾도록 이스케이프", () => {
  assert.equal(escapeLike("100%"), "%100\\%%");
  assert.equal(escapeLike("snake_case"), "%snake\\_case%");
  assert.equal(escapeLike("C:\\path"), "%C:\\\\path%");
});

test("float32ToBlob / blobToFloat32: 4,096 bytes 로 왕복해도 값이 같다", () => {
  const v = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.1);
  const blob = float32ToBlob(v);
  assert.equal(blob.byteLength, 4096);
  assert.deepEqual(blobToFloat32(blob), v);
});

test("blobToFloat32: D1 이 돌려줄 수 있는 여러 형태를 모두 받는다", () => {
  const v = Float32Array.from([0.5, -1.25, 3]);
  const bytes = new Uint8Array(float32ToBlob(v));
  assert.deepEqual(blobToFloat32(bytes), v); // Uint8Array 뷰
  assert.deepEqual(blobToFloat32([...bytes]), v); // 숫자 배열
  assert.deepEqual(blobToFloat32(bytes.buffer), v); // ArrayBuffer
});

test("float32ToBlob: 더 큰 버퍼의 일부인 Float32Array 도 자기 바이트만 넘긴다", () => {
  const big = new Float32Array(8).fill(9);
  const part = big.subarray(2, 4);
  assert.equal(float32ToBlob(part).byteLength, 8);
});

test("blobToFloat32: 4의 배수가 아니거나 모르는 타입이면 오류", () => {
  assert.throws(() => blobToFloat32(new Uint8Array(5)), /multiple of 4/);
  assert.throws(() => blobToFloat32("abc"), /unexpected BLOB type/);
});

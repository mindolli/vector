import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmbeddingInput, embed, EmptyInputError } from "../src/embed.ts";

const empty = { title: "", memo: "", description: "", content: "" };

test("buildEmbeddingInput: 제목 → 메모 → description → 본문 순서", () => {
  assert.equal(
    buildEmbeddingInput({ title: "제목", memo: "메모", description: "설명", content: "본문" }),
    "제목\n메모\n설명\n본문",
  );
});

test("buildEmbeddingInput: 빈 필드와 공백만 있는 필드는 건너뛴다", () => {
  assert.equal(buildEmbeddingInput({ ...empty, title: "제목", content: "  본문 " }), "제목\n본문");
  assert.equal(buildEmbeddingInput({ ...empty, memo: "   " }), "");
});

test("embed: 입력이 비어 있으면 모델을 부르지 않고 EmptyInputError", async () => {
  let called = false;
  const ai = { run: async () => { called = true; return {}; } } as unknown as Ai;
  await assert.rejects(embed(ai, "  "), EmptyInputError);
  assert.equal(called, false);
});

test("embed: 1024차원이 아니면 오류", async () => {
  const ai = { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) } as unknown as Ai;
  await assert.rejects(embed(ai, "text"), /expected 1024 dimensions/);
});

test("embed: 정상 응답은 Float32Array(1024)", async () => {
  const ai = { run: async () => ({ shape: [1, 1024], data: [Array(1024).fill(0.5)] }) } as unknown as Ai;
  const v = await embed(ai, "text");
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 1024);
  assert.equal(v.byteLength, 4096);
});

// 실제 원격 자원(Workers AI, 개발용 Vectorize 인덱스)으로 embed.ts 와 vector-store.ts 를 확인한다.
// wrangler 의 getPlatformProxy 로 wrangler.jsonc 의 바인딩을 Node 에서 불러온다.
// 로컬 D1 은 쓰지 않으며(persist: false), 확인용 벡터는 마지막에 지운다.
// 사용법: node scripts/probe-vectors.ts
import { getPlatformProxy } from "wrangler";
import { embed, EMBED_DIM } from "../src/embed.ts";
import { createVectorizeStore } from "../src/vector-store.ts";

const SENTENCES = [
  { id: 900001, lang: "ko", topic: "vector", text: "Cloudflare Workers에서 벡터 유사도 검색을 구현하는 방법" },
  { id: 900002, lang: "en", topic: "vector", text: "How to build vector similarity search on Cloudflare Workers" },
  { id: 900003, lang: "ko", topic: "stew", text: "김치찌개를 맛있게 끓이는 법" },
  { id: 900004, lang: "en", topic: "stew", text: "A simple recipe for Korean kimchi stew" },
];

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / Math.sqrt(na * nb);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const { env, dispose } = await getPlatformProxy<Env>({ persist: false });
const store = createVectorizeStore(env.VECTORIZE);
const ids = SENTENCES.map((s) => s.id);

try {
  console.log("1. 임베딩");
  const vectors = new Map<number, Float32Array>();
  for (const s of SENTENCES) {
    const t = Date.now();
    const v = await embed(env.AI, s.text);
    vectors.set(s.id, v);
    console.log(`     ${s.id} ${s.lang} ${Date.now() - t}ms  norm=${Math.sqrt(v.reduce((a, x) => a + x * x, 0)).toFixed(4)}`);
  }
  const v1 = vectors.get(900001)!;
  check(`길이 ${EMBED_DIM}, ${EMBED_DIM * 4} bytes`, v1.length === EMBED_DIM && v1.byteLength === EMBED_DIM * 4);

  console.log("2. 코사인 유사도");
  const header = "          " + SENTENCES.map((s) => `${s.lang}-${s.topic}`.padStart(10)).join("");
  console.log(header);
  for (const a of SENTENCES) {
    const row = SENTENCES.map((b) => cosine(vectors.get(a.id)!, vectors.get(b.id)!).toFixed(3).padStart(10)).join("");
    console.log(`${`${a.lang}-${a.topic}`.padEnd(10)}${row}`);
  }
  const sim = (x: number, y: number) => cosine(vectors.get(x)!, vectors.get(y)!);
  check("같은 주제의 한·영 문장이 다른 주제보다 가까움 (벡터)", sim(900001, 900002) > Math.max(sim(900001, 900003), sim(900001, 900004)));
  check("같은 주제의 한·영 문장이 다른 주제보다 가까움 (찌개)", sim(900003, 900004) > Math.max(sim(900003, 900001), sim(900003, 900002)));

  console.log("3. Vectorize (bookmarks-dev)");
  await store.upsert(SENTENCES.map((s) => ({ id: s.id, vector: vectors.get(s.id)! })));
  const t0 = Date.now();
  let result: { id: number; score: number }[] = [];
  while (Date.now() - t0 < 120_000) {
    try {
      result = await store.similar(900001, 3);
      if (result.length === 3) break;
    } catch { /* 아직 반영되지 않았으면 오류가 날 수 있다 */ }
    await sleep(2000);
  }
  console.log(`     upsert 후 조회에 반영되기까지 약 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  console.log(`     similar(900001, 3) = ${JSON.stringify(result)}`);
  check("자기 자신(900001)은 결과에 없음", result.length > 0 && result.every((m) => m.id !== 900001));
  check("1등은 같은 주제의 영어 문장(900002)", result[0]?.id === 900002);
  check("점수는 내림차순", result.every((m, i) => i === 0 || result[i - 1]!.score >= m.score));

  try {
    const none = await store.similar(123456789, 3);
    console.log(`     없는 id 로 조회: 오류 없이 ${JSON.stringify(none)}`);
  } catch (err) {
    console.log(`     없는 id 로 조회: 오류 발생 → ${String(err).slice(0, 160)}`);
  }
} finally {
  console.log("4. 정리");
  await store.delete(ids);
  console.log(`     확인용 벡터 ${ids.length}개 삭제 요청`);
  await dispose();
}

console.log(failures === 0 ? "\n결과: 모두 통과" : `\n결과: 실패 ${failures}개`);
process.exitCode = failures === 0 ? 0 : 1;

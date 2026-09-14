import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { HISTORY_KEY, HISTORY_LIMIT, readHistory, rememberVideo, writeHistory } from "../src/lib/history.ts";
import { extractVideoId } from "../src/lib/youtube.ts";

// A fixture key is confined to this process. The upstream fetch is replaced;
// these tests never send a paid request or need a real credential.
process.env.OPENROUTER_API_KEY = "test-fixture-not-a-real-key";
const { parseBody, guard, callAI, translateTranscript } = await import("../api/_lib.js");
const realFetch = globalThis.fetch;
const base = { videoId: "TEST1234567", title: "A video", author: "A channel" };

test("history deduplicates, orders by most recent visit, and preserves bookmarks", () => {
  let items = rememberVideo([], base, 1);
  items[0].saved = true;
  items = rememberVideo(items, { ...base, videoId: "OTHER123456" }, 2);
  items = rememberVideo(items, base, 3);
  assert.equal(items.length, 2); assert.equal(items[0].visitedAt, 3); assert.equal(items[0].saved, true);
});
test("history persists only metadata and caps at 100 unique videos", () => {
  let items = [];
  for (let i = 0; i < 110; i++) items = rememberVideo(items, { ...base, videoId: String(i).padStart(11, "0") }, i);
  assert.equal(items.length, HISTORY_LIMIT);
  const storage = { value: "", setItem(key, value) { assert.equal(key, HISTORY_KEY); this.value = value; }, getItem() { return this.value; } };
  writeHistory(storage, items); assert.deepEqual(readHistory(storage), items);
});
test("corrupt or blocked storage is reported, malformed entries cannot crash history", () => {
  assert.throws(() => readHistory({ getItem: () => "{" }));
  assert.throws(() => writeHistory({ setItem: () => { throw new Error("quota"); } }, []));
  assert.deepEqual(readHistory({ getItem: () => JSON.stringify([{ ...base, visitedAt: 1e99, saved: false }, null, {}]) }), []);
});
test("URL parser handles reordered parameters and mobile links while rejecting lookalikes", () => {
  for (const url of ["https://m.youtube.com/watch?si=abc&v=TEST1234567", "https://youtube.com/live/TEST1234567", "youtu.be/TEST1234567?si=abc", "https://music.youtube.com/watch?v=TEST1234567"]) assert.equal(extractVideoId(url), base.videoId);
  for (const url of ["https://fakeyoutube.com/watch?v=TEST1234567", "https://youtube.com.evil.test/watch?v=TEST1234567", "https://youtube.com/watch?v=TEST123456789"]) assert.equal(extractVideoId(url), null);
});
test("body parsing supports consumed production requests and raw UTF-8 streams", async () => {
  const body = { transcriptContext: "مرحبا بالعالم" };
  assert.deepEqual(await parseBody({ body }), body);
  assert.deepEqual(await parseBody({ body: JSON.stringify(body) }), body);
  assert.deepEqual(await parseBody({ body: Buffer.from(JSON.stringify(body)) }), body);
  assert.deepEqual(await parseBody(Readable.from([Buffer.from(JSON.stringify(body))])), body);
  const bytes = Buffer.from(JSON.stringify(body));
  assert.deepEqual(await parseBody(Readable.from([...bytes].map((byte) => Buffer.from([byte])))), body);
  await assert.rejects(parseBody({ body: { text: "x".repeat(100) } }, 20), { statusCode: 413 });
});
test("null, array, and primitive bodies return 400 rather than hang", async () => {
  for (const body of [null, [], 7, "false"]) {
    const response = { statusCode: 0, status(value) { this.statusCode = value; return this; }, json(value) { this.value = value; } };
    await guard({ method: "POST", headers: {}, body }, response);
    assert.equal(response.statusCode, 400);
  }
});
test("AI boundary sends timeout and model payload, validates failures and truncated output", async () => {
  try {
    let captured;
    globalThis.fetch = async (_url, options) => { captured = options; return Response.json({ choices: [{ message: { content: "Valid summary" }, finish_reason: "stop" }] }); };
    assert.equal(await callAI([{ role: "user", content: "Summarize" }], { json: true }), "Valid summary");
    assert.ok(captured.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(captured.body).response_format, { type: "json_object" });
    for (const fixture of [{ error: { message: "No credit" } }, { choices: [{ message: { content: "" } }] }, { choices: [{ message: { content: "Partial" }, finish_reason: "length" }] }]) {
      globalThis.fetch = async () => Response.json(fixture);
      await assert.rejects(callAI([]));
    }
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(callAI([]), /AI request failed/);
  } finally { globalThis.fetch = realFetch; }
});
test("long transcript translation retains chunk order", async () => {
  try {
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body); const input = payload.messages.at(-1).content;
      return Response.json({ choices: [{ message: { content: input.startsWith("A") ? "FIRST" : "SECOND" }, finish_reason: "stop" }] });
    };
    assert.equal(await translateTranscript([{ text: "A".repeat(6000) }, { text: "B".repeat(6000) }], "Arabic"), "FIRST [–––] SECOND");
  } finally { globalThis.fetch = realFetch; }
});

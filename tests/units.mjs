// Unit checks against the REAL parsers exported from src/lib/ai.ts.
// Node strips the TypeScript types natively (>= 22.18), so there is no build step.
import { group, check, summarise } from "./harness.mjs";
import {
  parseTranscriptXml,
  parseTranscriptJson3,
  formatTranscriptText,
} from "../src/lib/ai.ts";
import { extractJsonObject, normaliseShorts } from "../api/viral.js";

group("XML caption parsing");
{
  const single = parseTranscriptXml(`<text start="0" dur="1">it&#39;s fine &quot;ok&quot;</text>`);
  check("decodes single-escaped entities", single[0]?.text === `it's fine "ok"`, `got ${JSON.stringify(single[0]?.text)}`);

  const nested = parseTranscriptXml(`<text start="0" dur="1">A &amp;lt;b&amp;gt; tag</text>`);
  check("decodes nested lt/gt entities", nested[0]?.text === "A <b> tag", `got ${JSON.stringify(nested[0]?.text)}`);

  // YouTube double-escapes a literal ampersand as &amp;amp;. The decode chain
  // replaces /&amp;/ first, which consumes the outer entity and leaves "&amp;".
  const amp = parseTranscriptXml(`<text start="0" dur="1">Rock &amp;amp; Roll</text>`);
  check("decodes double-escaped ampersand", amp[0]?.text === "Rock & Roll",
    `got ${JSON.stringify(amp[0]?.text)} — chained replaces corrupt each other`, "F07");

  const ordered = parseTranscriptXml(`<text start="0" dur="1">hi</text>`);
  check("parses canonical attribute order", ordered.length === 1, `got ${ordered.length} segments`);

  const reordered = parseTranscriptXml(`<text dur="1" start="0">hi</text>`);
  check("tolerates reordered attributes", reordered.length === 1,
    `got ${reordered.length} segments — regex hardcodes start-then-dur, so the whole track is silently lost`, "F16");

  check("skips empty text nodes",
    parseTranscriptXml(`<text start="0" dur="1"></text><text start="2" dur="1">real</text>`).length === 1);

  check("reads start and duration as numbers", ordered[0]?.start === 0 && ordered[0]?.duration === 1,
    `got start=${ordered[0]?.start} duration=${ordered[0]?.duration}`);
}

group("JSON3 caption parsing");
{
  // Real fmt=json3 shape: timing lives on the EVENT; segments carry tOffsetMs.
  const json = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 2400, segs: [{ utf8: "Hello", tOffsetMs: 0 }, { utf8: " world", tOffsetMs: 800 }] },
      { tStartMs: 65800, dDurationMs: 4100, segs: [{ utf8: "Later line", tOffsetMs: 0 }] },
    ],
  });
  const segs = parseTranscriptJson3(json);

  check("extracts segment text", segs.map((s) => s.text).join("|") === "Hello|world|Later line",
    `got ${JSON.stringify(segs.map((s) => s.text))}`);

  check("reads start time from the event", segs[2]?.start === 65.8,
    `starts = ${JSON.stringify(segs.map((s) => s.start))} — code reads seg.tStartMs, which does not exist, so every segment is 0`, "F04");

  check("reads a real duration", segs[0]?.duration !== 2,
    `durations = ${JSON.stringify(segs.map((s) => s.duration))} — all fall back to the hardcoded 2s`, "F04");

  check("returns [] for malformed json", parseTranscriptJson3("{{{not json").length === 0);
}

group("Transcript text sent to the AI");
{
  const text = formatTranscriptText([
    { text: "a", start: 65.8, duration: 1 },
    { text: "b", start: 3725, duration: 1 },
  ]);
  check("formats minutes and seconds", text.includes("[1:05]"), `got ${JSON.stringify(text)}`);
  check("keeps hour-long videos unambiguous", text.includes("[1:02:05]"),
    `got ${JSON.stringify(text)} — 3725s renders as "62:05"; api/_lib.js formatTime() handles hours, this copy does not`, "F06");

  const many = Array.from({ length: 40000 }, (_, i) => ({ text: "word word word", start: i * 2, duration: 2 }));
  const truncated = formatTranscriptText(many);
  check("caps the payload at 50k chars", truncated.length <= 50000, `got ${truncated.length}`);
  check("tells the caller it truncated", false,
    `kept ${truncated.split("\n").length - 1} of ${many.length} segments and returns a bare string — the UI cannot tell`, "F13");
}

group("Viral shorts — surviving a cheaper model's output");
{
  const good = '{"shorts":[{"title":"A","script":"B"}]}';
  check("parses clean json", extractJsonObject(good)?.shorts?.length === 1);

  check("strips a markdown fence",
    extractJsonObject('```json\n' + good + '\n```')?.shorts?.length === 1,
    "models wrap json in fences even when asked not to");

  check("survives preamble and trailing prose",
    extractJsonObject('Sure! Here you go:\n' + good + '\nHope that helps.')?.shorts?.length === 1,
    "scans for the first balanced object instead of trusting the whole string");

  check("handles braces inside strings",
    extractJsonObject('{"shorts":[{"title":"use {curly} braces","script":"B"}]}')?.shorts?.[0]?.title
      === "use {curly} braces");

  check("returns null for truncated json, rather than throwing",
    extractJsonObject('{"shorts":[{"title":"A","scr') === null,
    "a truncated response must fail cleanly so the handler can return 502");

  check("returns null for no json at all",
    extractJsonObject("I could not find any good clips.") === null);

  const messy = normaliseShorts({ shorts: [
    { title: "Good", script: "S", viralScore: "150", startTime: "12.5", captions: "not-an-array", hashtags: ["#a", 7] },
    { title: "Missing script" },
    null,
  ]});
  check("drops entries the UI cannot render", messy.length === 1, `kept ${messy.length}`);
  check("clamps viralScore into 0-100", messy[0].viralScore === 100, `got ${messy[0].viralScore}`);
  check("coerces numeric strings", messy[0].startTime === 12.5, `got ${messy[0].startTime}`);
  check("forces captions/hashtags to clean arrays",
    Array.isArray(messy[0].captions) && messy[0].captions.length === 0 && messy[0].hashtags.length === 1,
    JSON.stringify({ c: messy[0].captions, h: messy[0].hashtags }));
}

group("Model configuration");
{
  const lib = await import("../api/_lib.js");
  check("every task has a model", ["chat", "summary", "viral", "translate"].every((k) => !!lib.MODELS[k]),
    JSON.stringify(lib.MODELS));
  check("defaults are the cheap tier for chat and summary",
    lib.MODELS.chat === "openai/gpt-5-nano" && lib.MODELS.summary === "openai/gpt-5-nano",
    JSON.stringify(lib.MODELS));
  check("no task still points at the old expensive model",
    !Object.values(lib.MODELS).includes("~openai/gpt-mini-latest"), JSON.stringify(lib.MODELS));
}

summarise("Units");

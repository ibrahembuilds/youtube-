// Unit checks against the REAL parsers exported from src/lib/ai.ts.
// Node strips the TypeScript types natively (>= 22.18), so there is no build step.
import { group, check, summarise } from "./harness.mjs";
import {
  parseTranscriptXml,
  parseTranscriptJson3,
  formatTranscriptText,
  formatTimestamp,
  transcriptCoverage,
  parseTimestamp,
  splitTimestamps,
  parseTranslatedLines,
  batchSegments,
} from "../src/lib/ai.ts";
import {
  extractJsonObject, normaliseShorts, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS,
} from "../api/viral.js";
import { classifyWatchPage } from "../api/_lib.js";
import { buildCaptionUrl } from "../api/captions.js";
import { interpreterUrlFrom } from "../api/_youtube.js";

group("XML caption parsing");
{
  const one = parseTranscriptXml(`<text start="0" dur="1">it&#39;s fine &quot;ok&quot;</text>`);
  check("decodes single-escaped entities", one[0]?.text === `it's fine "ok"`, `got ${JSON.stringify(one[0]?.text)}`);

  // YouTube writes a literal & as &amp;amp;. Chained replaces used to eat the
  // outer entity first and leave "&amp;" visible in the transcript.
  const amp = parseTranscriptXml(`<text start="0" dur="1">Rock &amp;amp; Roll</text>`);
  check("decodes double-escaped ampersand", amp[0]?.text === "Rock & Roll", `got ${JSON.stringify(amp[0]?.text)}`);

  check("decodes nested lt/gt", parseTranscriptXml(`<text start="0" dur="1">A &amp;lt;b&amp;gt; tag</text>`)[0]?.text === "A <b> tag");

  check("decodes numeric references",
    parseTranscriptXml(`<text start="0" dur="1">caf&#233; &#x627;&#x644;&#x639;</text>`)[0]?.text === "café الع",
    `got ${JSON.stringify(parseTranscriptXml(`<text start="0" dur="1">caf&#233; &#x627;&#x644;&#x639;</text>`)[0]?.text)}`);

  check("leaves an unknown entity alone rather than mangling it",
    parseTranscriptXml(`<text start="0" dur="1">5 &widget; 3</text>`)[0]?.text === "5 &widget; 3");

  check("parses canonical attribute order", parseTranscriptXml(`<text start="0" dur="1">hi</text>`).length === 1);

  // The regex used to hard-code start-then-dur, so any variation silently
  // dropped the entire track.
  check("tolerates reordered attributes", parseTranscriptXml(`<text dur="1" start="0">hi</text>`).length === 1,
    `got ${parseTranscriptXml(`<text dur="1" start="0">hi</text>`).length} segments`);
  check("tolerates a missing dur", parseTranscriptXml(`<text start="7">hi</text>`).length === 1);
  check("tolerates extra attributes", parseTranscriptXml(`<text start="0" dur="1" w="1" wWinId="0">hi</text>`).length === 1);
  check("skips a segment with no start", parseTranscriptXml(`<text dur="1">hi</text>`).length === 0);

  check("strips inline markup",
    parseTranscriptXml(`<text start="0" dur="1">a <b>bold</b> word</text>`)[0]?.text === "a bold word");

  check("handles multi-line caption bodies",
    parseTranscriptXml(`<text start="0" dur="1">line one\nline two</text>`)[0]?.text === "line one line two");

  check("skips empty text nodes",
    parseTranscriptXml(`<text start="0" dur="1"></text><text start="2" dur="1">real</text>`).length === 1);

  check("reads start and duration as numbers",
    parseTranscriptXml(`<text start="1.5" dur="2.25">hi</text>`)[0]?.start === 1.5);
}

group("JSON3 caption parsing");
{
  // Real fmt=json3 shape: timing on the EVENT, offsets on the segments.
  const real = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 2400, segs: [{ utf8: "Hello", tOffsetMs: 0 }, { utf8: " world", tOffsetMs: 800 }] },
    { tStartMs: 65800, dDurationMs: 4100, segs: [{ utf8: "Later line", tOffsetMs: 0 }] },
    { tStartMs: 3725000, dDurationMs: 2500, segs: [{ utf8: "Past an hour", tOffsetMs: 0 }] },
  ]});
  const segs = parseTranscriptJson3(real);

  check("joins an event's word-level pieces into one line",
    segs[0]?.text === "Hello world",
    `got ${JSON.stringify(segs.map((x) => x.text))} — YouTube splits captions per word`);

  check("reads start time from the event, not the segment",
    segs[1]?.start === 65.8, `starts = ${JSON.stringify(segs.map((x) => x.start))}`);

  check("reads duration from the event", segs[0]?.duration === 2.4,
    `durations = ${JSON.stringify(segs.map((x) => x.duration))}`);

  check("keeps sub-hour and past-hour starts distinct",
    segs[2]?.start === 3725, `got ${segs[2]?.start}`);

  check("drops events with no text",
    parseTranscriptJson3(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "\n" }] }] })).length === 0);

  check("returns [] for malformed json", parseTranscriptJson3("{{{not json").length === 0);
  check("returns [] when events is missing", parseTranscriptJson3("{}").length === 0);
}

group("Timestamps the AI quotes back");
{
  check("under a minute", formatTimestamp(41) === "0:41", formatTimestamp(41));
  check("minutes and seconds", formatTimestamp(65.8) === "1:05", formatTimestamp(65.8));
  // 3725s used to render as "62:05" — a timestamp no viewer can find.
  check("past one hour", formatTimestamp(3725) === "1:02:05", formatTimestamp(3725));
  check("past two hours", formatTimestamp(7385) === "2:03:05", formatTimestamp(7385));
  check("exactly one hour", formatTimestamp(3600) === "1:00:00", formatTimestamp(3600));
  check("zero", formatTimestamp(0) === "0:00", formatTimestamp(0));
  check("negative is clamped", formatTimestamp(-5) === "0:00", formatTimestamp(-5));
  check("non-numeric is safe", formatTimestamp(NaN) === "0:00", formatTimestamp(NaN));

  const text = formatTranscriptText([
    { text: "a", start: 65.8, duration: 1 },
    { text: "b", start: 3725, duration: 1 },
  ]);
  check("the AI context uses hour-aware timestamps",
    text.includes("[1:05]") && text.includes("[1:02:05]"), JSON.stringify(text));
}

group("Truncation is reported, not hidden");
{
  const many = Array.from({ length: 40000 }, (_, i) => ({ text: "word word word", start: i * 2, duration: 2 }));
  const out = formatTranscriptText(many);
  check("caps the payload", out.length <= 50000, `got ${out.length}`);

  const cov = transcriptCoverage(many);
  check("reports that it truncated", cov.truncated === true);
  check("reports how much was included",
    cov.includedSegments > 0 && cov.includedSegments < cov.totalSegments,
    `${cov.includedSegments} of ${cov.totalSegments}`);
  check("reports where coverage stops",
    cov.lastIncludedStart > 0 && formatTimestamp(cov.lastIncludedStart).includes(":"),
    `stops at ${formatTimestamp(cov.lastIncludedStart)}`);

  const small = transcriptCoverage([{ text: "a", start: 0, duration: 1 }]);
  check("a short transcript is not reported as truncated", small.truncated === false);
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
    { title: "Good", script: "S", viralScore: "150", startTime: "12.5", endTime: "42.5",
      captions: "not-an-array", hashtags: ["#a", 7] },
    { title: "Missing script", startTime: 0, endTime: 30 },
    null,
  ]});
  check("drops entries the UI cannot render", messy.length === 1, `kept ${messy.length}`);
  check("clamps viralScore into 0-100", messy[0].viralScore === 100, `got ${messy[0].viralScore}`);
  check("coerces numeric strings", messy[0].startTime === 12.5, `got ${messy[0].startTime}`);
  check("forces captions/hashtags to clean arrays",
    Array.isArray(messy[0].captions) && messy[0].captions.length === 0 && messy[0].hashtags.length === 1,
    JSON.stringify({ c: messy[0].captions, h: messy[0].hashtags }));
}

group("Viral clip durations must be usable as Shorts");
{
  // Measured against the live endpoint before this was constrained: a real
  // 30-minute transcript produced clips of 4, 4, 4, 4, 4 seconds, and a short
  // transcript produced one of 112 seconds. Neither is a publishable Short.
  const clip = (startTime, endTime) => ({ title: "T", script: "S", startTime, endTime });

  const kept = normaliseShorts({ shorts: [
    clip(0, 4),      // the 4-second case seen live
    clip(10, 40),    // good
    clip(60, 105),   // good
    clip(190, 302),  // the 112-second case seen live
  ]});
  check("drops clips too short to publish",
    !kept.some((c) => c.endTime - c.startTime < MIN_CLIP_SECONDS),
    `kept spans: ${JSON.stringify(kept.map((c) => c.endTime - c.startTime))}`);
  check("drops clips too long for short-form",
    !kept.some((c) => c.endTime - c.startTime > MAX_CLIP_SECONDS),
    `kept spans: ${JSON.stringify(kept.map((c) => c.endTime - c.startTime))}`);
  check("keeps the usable ones", kept.length === 2,
    `kept ${kept.length}: ${JSON.stringify(kept.map((c) => `${c.startTime}-${c.endTime}`))}`);

  check("a boundary-length clip is kept",
    normaliseShorts({ shorts: [clip(0, MIN_CLIP_SECONDS)] }).length === 1,
    "the limit itself must not be excluded");

  check("all-unusable input yields nothing, so the handler can say so",
    normaliseShorts({ shorts: [clip(0, 3), clip(10, 14)] }).length === 0);

  check("the prompt states the duration requirement",
    /between 20 and 60 seconds/.test(
      (await import("node:fs")).readFileSync("api/viral.js", "utf8")),
    "validation alone just drops clips — the model has to be told the target");
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

group("Watch-page classification (F08 decision table)");
{
  // A real watch page is ~1.4MB. Pad fixtures past the 50KB "is this a real
  // page" threshold so the size check does not short-circuit the status logic.
  const pad = " ".repeat(60000);
  const page = (playability, extra = "") =>
    `<html>${pad}"playabilityStatus":{${playability}}${extra}</html>`;
  const tracks = `,"captionTracks":[{"baseUrl":"https://x/t","languageCode":"en","name":{"simpleText":"English"}}]`;

  check("healthy page with captions -> ok",
    classifyWatchPage(200, page('"status":"OK"', tracks)).kind === "ok");

  check("healthy page with no caption tracks -> none",
    classifyWatchPage(200, page('"status":"OK"')).kind === "none");

  // Measured on the live site: jNQXAC9IVRw, a public and perfectly available
  // video, returns exactly this to a datacenter IP.
  const botCheck = classifyWatchPage(200,
    page('"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you\u2019re not a bot"'));
  check("LOGIN_REQUIRED + 'not a bot' -> blocked, NOT unavailable",
    botCheck.kind === "blocked",
    `got "${botCheck.kind}" — calling YouTube's bot check a private video sends the user after the wrong problem`);

  check("LOGIN_REQUIRED + a real reason -> unavailable",
    classifyWatchPage(200,
      page('"status":"LOGIN_REQUIRED","reason":"This video is private"')).kind === "unavailable");

  const gone = classifyWatchPage(200,
    page('"status":"ERROR","reason":"This video is unavailable"'));
  check("ERROR -> unavailable", gone.kind === "unavailable");
  check("passes YouTube's own wording through",
    gone.detail.includes("This video is unavailable"), `detail: ${gone.detail}`);

  check("UNPLAYABLE -> unavailable",
    classifyWatchPage(200, page('"status":"UNPLAYABLE","reason":"Not available in your country"')).kind === "unavailable");

  check("AGE_VERIFICATION_REQUIRED -> unavailable",
    classifyWatchPage(200, page('"status":"AGE_VERIFICATION_REQUIRED"')).kind === "unavailable");

  check("HTTP 429 -> throttled", classifyWatchPage(429, "").kind === "throttled");
  check("HTTP 403 -> throttled", classifyWatchPage(403, "").kind === "throttled");
  check("HTTP 404 -> unavailable", classifyWatchPage(404, "").kind === "unavailable");
  check("HTTP 503 -> transient", classifyWatchPage(503, "").kind === "transient");

  // A throttle response measured 3.2KB against a real page's 1.4MB.
  check("200 with a tiny body -> throttled, not 'no captions'",
    classifyWatchPage(200, "<html>blocked</html>").kind === "throttled",
    "a few KB never contained a player response, whatever the status code");

  check("the word UNPLAYABLE elsewhere on a healthy page is ignored",
    classifyWatchPage(200, page('"status":"OK"', tracks + ',"someOtherField":"UNPLAYABLE"')).kind === "ok",
    "reads playabilityStatus specifically instead of scanning 1.4MB for keywords");
}

group("Caption URLs get a PO token, and nothing else gets through");
{
  const base = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&ei=x&caps=asr&opi=1&exp=xpe&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=1&sparams=ip&signature=AB&key=yt8&lang=en";
  const built = new URL(buildCaptionUrl(base, "dQw4w9WgXcQ", "TOKEN_123"));
  check("adds pot, c=WEB and fmt=json3",
    built.searchParams.get("pot") === "TOKEN_123" && built.searchParams.get("c") === "WEB" && built.searchParams.get("fmt") === "json3",
    built.search);
  check("keeps YouTube's signature untouched",
    built.searchParams.get("signature") === "AB" && built.searchParams.get("exp") === "xpe", built.search);
  check("replaces an existing fmt instead of duplicating it",
    new URL(buildCaptionUrl(base + "&fmt=srv3", "dQw4w9WgXcQ", "T")).searchParams.getAll("fmt").join() === "json3");
  check("no token -> no pot or c param",
    !/[?&](pot|c)=/.test(buildCaptionUrl(base, "dQw4w9WgXcQ", null)));

  const rejected = [
    ["another host", "https://evil.example/api/timedtext?v=dQw4w9WgXcQ"],
    ["a lookalike host", "https://www.youtube.com.evil.example/api/timedtext?v=dQw4w9WgXcQ"],
    ["plain http", "http://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ"],
    ["another path", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["another video", "https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA"],
    ["credentials", "https://u:p@www.youtube.com/api/timedtext?v=dQw4w9WgXcQ"],
    ["a port", "https://www.youtube.com:8443/api/timedtext?v=dQw4w9WgXcQ"],
    ["not a string", 42],
  ];
  for (const [label, url] of rejected) {
    check(`rejects ${label}`, buildCaptionUrl(url, "dQw4w9WgXcQ", "T") === null);
  }
}

group("BotGuard interpreter only runs from Google");
{
  check("accepts the protocol-relative URL YouTube embeds",
    interpreterUrlFrom("//www.google.com/js/th/nwgAyqBHFFi2W9LKQghwb3A0rEg5C-dyKchYZGE_VuI.js")
      === "https://www.google.com/js/th/nwgAyqBHFFi2W9LKQghwb3A0rEg5C-dyKchYZGE_VuI.js");
  for (const [label, url] of [
    ["another host", "//evil.example/js/th/x.js"],
    ["a lookalike host", "//www.google.com.evil.example/js/th/x.js"],
    ["another path on google.com", "//www.google.com/url?q=https://evil.example"],
    ["plain http", "http://www.google.com/js/th/x.js"],
    ["a missing value", undefined],
  ]) {
    check(`rejects ${label}`, interpreterUrlFrom(url) === null);
  }
}

group("Timestamps in AI answers become seek targets");
{
  check("m:ss", parseTimestamp("1:05") === 65);
  check("h:mm:ss", parseTimestamp("1:02:05") === 3725);
  check("rejects 61 seconds", parseTimestamp("1:61") === null);
  check("rejects minutes past 59 when hours are present", parseTimestamp("1:75:00") === null);
  check("rejects prose", parseTimestamp("soon") === null);

  const parts = splitTimestamps("See [1:05] and [1:02:05], not 3:15.");
  check("splits bracketed timestamps out of prose",
    JSON.stringify(parts) === JSON.stringify(["See ", { label: "1:05", seconds: 65 }, " and ", { label: "1:02:05", seconds: 3725 }, ", not 3:15."]),
    JSON.stringify(parts));
  check("text with no timestamps is one plain run", JSON.stringify(splitTimestamps("plain")) === JSON.stringify(["plain"]));
  check("an impossible bracketed time stays text",
    JSON.stringify(splitTimestamps("at [9:99]")) === JSON.stringify(["at [9:99]"]));
}

group("Translations keep their timestamps");
{
  const rows = parseTranslatedLines("[0:00] مرحبا\n[1:05] النقطة الأولى\nتكملة السطر\n[1:02:05] النهاية");
  check("reads one row per timestamped line", rows?.length === 3, JSON.stringify(rows));
  check("keeps the start time", rows?.[1].start === 65 && rows?.[2].start === 3725);
  check("folds a wrapped line into the previous row", rows?.[1].text === "النقطة الأولى تكملة السطر", rows?.[1].text);
  check("plain prose is not forced into rows", parseTranslatedLines("Un texte sans horodatage.") === null);
  check("empty text is null", parseTranslatedLines("") === null);
}

group("Long transcripts translate in batches");
{
  const segs = Array.from({ length: 10 }, (_, i) => ({ text: "x".repeat(100), start: i, duration: 1 }));
  const batches = batchSegments(segs, 250);
  check("no batch exceeds the limit", batches.every((b) => b.reduce((n, s) => n + s.text.length, 0) <= 250));
  check("no segment is lost or reordered", batches.flat().map((s) => s.start).join() === segs.map((s) => s.start).join());
  check("an oversize single segment still gets a batch", batchSegments([{ text: "y".repeat(500), start: 0, duration: 1 }], 250).length === 1);
}

summarise("Units");

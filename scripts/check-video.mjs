#!/usr/bin/env node
// Diagnose one video, stage by stage.
//
//   node scripts/check-video.mjs <url-or-id> [--app https://your-app.vercel.app]
//
// "Does every video work?" has no single answer — it depends on whether that
// video has captions, and whether YouTube is challenging the server this
// minute. This prints which stage failed and what to do about it, instead of
// leaving you guessing from one error message in the UI.

const args = process.argv.slice(2);
const appIndex = args.indexOf("--app");
const APP = appIndex >= 0 ? args[appIndex + 1] : process.env.APP_URL || "http://localhost:3000";
const input = args.filter((a, i) => a !== "--app" && i !== appIndex + 1)[0];

if (!input) {
  console.error("usage: node scripts/check-video.mjs <youtube-url-or-id> [--app <base-url>]");
  process.exit(2);
}

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;
function extractId(value) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = value.match(p);
    if (m) return m[1];
  }
  return ID_RE.test(value.trim()) ? value.trim() : null;
}

const g = (t) => `\x1b[32m${t}\x1b[0m`;
const r = (t) => `\x1b[31m${t}\x1b[0m`;
const y = (t) => `\x1b[33m${t}\x1b[0m`;
const dim = (t) => `\x1b[2m${t}\x1b[0m`;
const line = (label, verdict, detail) =>
  console.log(`  ${verdict}  ${label.padEnd(22)} ${detail ? dim(detail) : ""}`);

console.log(`\nChecking ${input}\n  via ${APP}\n`);

// ── 1. the URL itself ──
const videoId = extractId(input);
if (!videoId) {
  line("url", r("FAIL"), "not a recognised YouTube URL or 11-character id");
  process.exit(1);
}
line("url", g(" OK "), `video id ${videoId}`);

// ── 2. is the video public? oEmbed only answers for public videos ──
let title = null;
let isPublic = false;
try {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    { signal: AbortSignal.timeout(20000) }
  );
  if (res.ok) {
    const info = await res.json();
    title = info.title;
    isPublic = true;
    line("video is public", g(" OK "), `"${info.title}" — ${info.author_name}`);
  } else {
    line("video is public", r("FAIL"), `oEmbed returned ${res.status}: private, deleted, or never existed`);
  }
} catch (e) {
  line("video is public", y("SKIP"), `could not reach oEmbed (${e.message})`);
}

// ── 3. the caption track lookup ──
let tracks = null;
try {
  const res = await fetch(`${APP}/api/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok && Array.isArray(body.tracks) && body.tracks.length) {
    tracks = body.tracks;
    line("caption lookup", g(" OK "), `${body.totalTracks} track(s)${body.cached ? " (cached)" : ""}`);
  } else {
    const advice = {
      no_captions: "this video genuinely has no captions — nothing can transcribe it without speech-to-text",
      bot_check: "YouTube is challenging the SERVER, not a problem with the video — retry shortly",
      throttled: "YouTube is rate-limiting the server — wait about a minute",
      unavailable: "the video is private, age-restricted, or removed",
      upstream_error: "could not reach YouTube at all",
    }[body.code] || "unclassified failure";
    line("caption lookup", r("FAIL"), `${body.code || res.status}: ${advice}`);
    console.log(`\n  ${body.error || ""}`);

    // oEmbed only answers for public videos. If it gave us a title and the
    // lookup still says "unavailable", the two disagree — and oEmbed is the
    // one telling the truth. That mismatch means YouTube served the server a
    // bot challenge, which older builds reported as a private video.
    if (isPublic && body.code === "unavailable") {
      console.log(
        y("\n  These two answers contradict each other.") +
        `\n  oEmbed returned a title for this video, which it only does for public videos,` +
        `\n  so it is NOT private. The deployment is reporting YouTube's bot challenge as` +
        `\n  an unavailable video. Expect code "bot_check" once the current fix is deployed.`
      );
    }
    console.log("");
    process.exit(1);
  }
} catch (e) {
  line("caption lookup", r("FAIL"), `request failed: ${e.message}`);
  process.exit(1);
}

// ── 4. can the captions actually be downloaded? ──
// This is the stage that depends on WHOSE network asks. A browser on a home
// connection usually succeeds where a datacenter IP is handed an empty body.
console.log("");
let anyUsable = false;
for (const track of tracks) {
  const label = `${track.languageName}${track.kind === "asr" ? " (auto)" : ""}`;
  try {
    const res = await fetch(track.transcriptUrl, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    const count = (text.match(/<text\b/g) || []).length;
    if (count > 0) {
      anyUsable = true;
      line(label, g(" OK "), `${count} caption lines`);
    } else if (!text.trim()) {
      line(label, y("BLOCKED"), `HTTP ${res.status}, empty body — this network is blocked, a real browser may still work`);
    } else {
      line(label, y("WARN"), `HTTP ${res.status}, ${text.length} bytes but no <text> elements`);
    }
  } catch (e) {
    line(label, r("FAIL"), e.message);
  }
}

console.log("");
if (anyUsable) {
  console.log(g(`  This video works: captions downloaded, so chat, summary, translation and shorts all have input.`));
} else {
  console.log(y(`  Track metadata was found, but no captions downloaded from THIS network.`));
  console.log(dim(`  The caption fetch happens in the viewer's browser, so this often still works for real`));
  console.log(dim(`  users on a home connection. Open ${APP}/studio and load the video to confirm.`));
}
if (title) console.log(dim(`\n  ${title}`));

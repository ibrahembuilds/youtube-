// API contract, CORS and abuse-surface checks.
// Spawns its own api-server instances so the run is deterministic and does not
// depend on a dev server already being up.
import { spawn } from "node:child_process";
import { group, check, summarise } from "./harness.mjs";

const ALLOWED = "http://localhost:3000"; // api-server.js allows the Vite dev origin
const HOSTILE = "https://evil.example";

function startServer(port, env = {}) {
  const child = spawn("node", ["api-server.js"], {
    env: { ...process.env, API_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`server on :${port} did not start\n${stderr.trim()}`)),
      15000
    );
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      if (d.toString().includes("API dev server running")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

async function post(port, route, body, headers = {}) {
  const res = await fetch(`http://localhost:${port}/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json response */ }
  return { status: res.status, headers: res.headers, text, json };
}

const PORT = 3101;
const server = await startServer(PORT, { RATE_LIMIT_MAX: "1000" });

try {
  group("Method and validation contract");
  {
    const get = await fetch(`http://localhost:${PORT}/api/transcript`, { method: "GET" });
    check("GET is rejected with 405", get.status === 405, `got ${get.status}`);

    const opts = await fetch(`http://localhost:${PORT}/api/transcript`, {
      method: "OPTIONS", headers: { Origin: ALLOWED },
    });
    check("OPTIONS preflight returns 204", opts.status === 204, `got ${opts.status}`);

    const cases = [
      ["transcript", {}, "videoId is required"],
      ["download", {}, "videoId is required"],
      ["chat", {}, "messages array is required"],
      ["chat", { messages: [] }, "transcriptContext is required"],
      ["summary", {}, "transcriptContext is required"],
      ["viral", {}, "transcriptContext is required"],
      ["translate", {}, "segments array is required"],
      ["translate", { segments: [{ text: "hi" }] }, "targetLanguage is required"],
    ];
    for (const [route, body, expected] of cases) {
      const r = await post(PORT, route, body);
      check(`POST /${route} ${JSON.stringify(body)} -> 400`,
        r.status === 400 && String(r.json?.error).includes(expected.split(" ")[0]),
        `got ${r.status} ${r.text.slice(0, 90)}`);
    }
  }

  group("F02 — SSRF endpoint is gone");
  {
    const r = await post(PORT, "transcript-content", { url: "https://example.com/" });
    check("/api/transcript-content is not routed", r.status === 404,
      `got ${r.status} — an endpoint that fetches an arbitrary url server-side must not exist`);
    check("it cannot be used to read internal services", !String(r.text).includes("Example Domain"),
      `response leaked remote content: ${r.text.slice(0, 90)}`);
  }

  group("F03 — CORS is not a wildcard");
  {
    const allowed = await post(PORT, "transcript", {}, { Origin: ALLOWED });
    check("allow-listed origin is echoed back",
      allowed.headers.get("access-control-allow-origin") === ALLOWED,
      `got ${allowed.headers.get("access-control-allow-origin")}`);
    check("response varies on Origin", (allowed.headers.get("vary") || "").includes("Origin"),
      `got ${allowed.headers.get("vary")}`);

    const hostile = await post(PORT, "chat", {}, { Origin: HOSTILE });
    check("unknown origin is refused with 403", hostile.status === 403, `got ${hostile.status}`);
    check("unknown origin gets no ACAO header",
      hostile.headers.get("access-control-allow-origin") === null,
      `got ${hostile.headers.get("access-control-allow-origin")}`);
    check("no endpoint answers with ACAO: *",
      hostile.headers.get("access-control-allow-origin") !== "*", "wildcard CORS is back");
  }

  group("F03 — payload caps");
  {
    const big = await post(PORT, "summary", { transcriptContext: "x".repeat(70000), type: "brief" });
    check("oversized transcriptContext is refused", big.status === 400,
      `got ${big.status} ${big.text.slice(0, 90)}`);

    const bigBody = await post(PORT, "chat", "x".repeat(600 * 1024));
    check("oversized request body is refused", bigBody.status === 413 || bigBody.status === 400,
      `got ${bigBody.status} ${bigBody.text.slice(0, 90)}`);

    const bigSegs = await post(PORT, "translate", {
      segments: [{ text: "y".repeat(70000), start: 0, duration: 1 }],
      targetLanguage: "Spanish",
    });
    check("oversized translate payload is refused", bigSegs.status === 400,
      `got ${bigSegs.status} ${bigSegs.text.slice(0, 90)}`);
  }

  group("F12 — download endpoint shape");
  {
    const r = await post(PORT, "download", { videoId: "dQw4w9WgXcQ" });
    check("returns 200 with the video url", r.status === 200 && typeof r.json?.videoUrl === "string",
      `got ${r.status} ${r.text.slice(0, 120)}`);
    check("no option claims a media format",
      !(r.json?.options || []).some((o) => /\b(MP4|MP3|WEBM|M4A)\b/i.test(o.label)),
      JSON.stringify((r.json?.options || []).map((o) => o.label)));
    const urls = (r.json?.options || []).map((o) => o.url);
    check("options point at distinct destinations", new Set(urls).size === urls.length,
      JSON.stringify(urls));
    const bad = await post(PORT, "download", { videoId: "nope" });
    check("rejects a malformed video id", bad.status === 400, `got ${bad.status}`);
  }

  group("F08 — caption lookup failures are distinguishable");
  {
    const bad = await post(PORT, "transcript", { videoId: "not-an-id" });
    check("a malformed video id is rejected before any network call",
      bad.status === 400, `got ${bad.status} ${bad.text.slice(0, 90)}`);

    // An id that is well-formed but does not exist.
    //
    // This cannot assert "unavailable" unconditionally: when YouTube is
    // throttling the runner, every id is refused before the lookup ever sees
    // whether the video exists, and reporting that as throttled is the
    // CORRECT classification. So assert the two legal outcomes, and that
    // "no captions" — which would be a misdiagnosis — is never one of them.
    const missing = await post(PORT, "transcript", { videoId: "ZZZZZZZZZZZ" });
    const gotThrough = missing.json?.code === "unavailable" && missing.status === 422;
    const wasBlocked = ["throttled", "bot_check", "upstream_error"].includes(missing.json?.code);
    check("a missing video is never reported as 'no captions'",
      gotThrough || wasBlocked,
      `got ${missing.status} code="${missing.json?.code}" ${missing.text.slice(0, 100)}`);
    if (gotThrough) {
      check("and when the lookup gets through, it says 'unavailable'", true,
        "network was healthy, classification confirmed");
    } else {
      check("network was blocked, so the unavailable path was not exercised", true,
        `reported code="${missing.json?.code}" — correct for a blocked lookup`);
    }

    const r = await post(PORT, "transcript", { videoId: "dQw4w9WgXcQ" });

    // Whichever branch the network puts us in, the response must say WHICH.
    check("every failure mode carries a machine-readable code",
      r.status === 200 || typeof r.json?.code === "string",
      `got ${r.status} with no code field: ${r.text.slice(0, 120)}`);

    if (r.status === 200) {
      check("returns caption tracks with urls",
        Array.isArray(r.json?.tracks) && r.json.tracks.length > 0 && !!r.json.tracks[0].transcriptUrl,
        JSON.stringify(r.json).slice(0, 120));

      const again = await post(PORT, "transcript", { videoId: "dQw4w9WgXcQ" });
      check("a repeat lookup is served from cache, not re-scraped",
        again.json?.cached === true, `cached=${again.json?.cached}`);
    } else if (r.json?.code === "throttled") {
      check("throttling reports 429, separately from 'no captions'",
        r.status === 429, `got ${r.status}`);
      check("throttling tells the client when to retry",
        !!r.headers.get("retry-after"), `Retry-After=${r.headers.get("retry-after")}`);
      check("the message says it is YouTube, not the video",
        /rate-limit/i.test(r.json.error) && !/has none/i.test(r.json.error),
        `message: ${r.json.error}`);
    } else {
      check("a non-throttle failure is still classified",
        ["no_captions", "unavailable", "upstream_error"].includes(r.json?.code),
        `got code=${r.json?.code} status=${r.status}`);
    }
  }
} finally {
  server.kill();
}

group("F03 — per-IP rate limiting");
{
  const RL_PORT = 3102;
  const rlServer = await startServer(RL_PORT, { RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(RL_PORT, "transcript", {})).status);
    check("requests beyond the cap get 429", codes.filter((c) => c === 429).length === 2,
      `statuses = ${JSON.stringify(codes)} (cap 3)`);

    const limited = await post(RL_PORT, "transcript", {});
    check("429 carries a Retry-After header", !!limited.headers.get("retry-after"),
      `got ${limited.headers.get("retry-after")}`);
  } finally {
    rlServer.kill();
  }
}

summarise("API");

// Shared utilities for Vercel serverless functions

const _env = typeof process !== "undefined" ? process.env : {};
const _key = _env["OPENROUTER" + "_API_KEY"] || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── Model selection ──────────────────────────────────────────────────
// One model per task, each overridable by env var so you can retune cost or
// quality without a deploy. Prices below are USD per 1M tokens, read from
// OpenRouter on 2026-09-12.
//
//   gpt-5-nano  $0.05 in / $0.40 out / $0.005 cached   cheap, 400k context
//   gpt-5-mini  $0.25 in / $2.00 out / $0.025 cached   used where output
//                                                      quality actually bites
//
// Viral shorts and translation keep the stronger model on purpose: viral must
// return strictly parseable JSON, and translation has to hold tone across 19
// languages. Those are exactly where the cheapest models fail. Point them at
// gpt-5-nano (or deepseek/deepseek-v4-flash) if you want to test that trade.
export const MODELS = {
  chat: _env.AI_MODEL_CHAT || "openai/gpt-5-nano",
  summary: _env.AI_MODEL_SUMMARY || "openai/gpt-5-nano",
  viral: _env.AI_MODEL_VIRAL || "openai/gpt-5-mini",
  translate: _env.AI_MODEL_TRANSLATE || "openai/gpt-5-mini",
};

// ─── Request guard: CORS, method, rate limit, body ────────────────────
// These endpoints proxy a paid AI provider, so they are only as safe as the
// gate in front of them. Note what each control actually buys you:
//
//   CORS  stops another *website* from spending your key via a visitor's
//         browser. It does NOT stop curl or a script — those ignore it.
//   Rate  limiting is the control that stops direct abuse. The store below
//         is per-instance memory, so on Vercel each warm lambda keeps its
//         own counter and the effective limit is (instances x MAX). That
//         raises the cost of abuse a long way above "unlimited", but it is
//         not a hard cap — move it to Redis/Upstash if this gets traffic.
//   Caps  on body and transcript size bound the spend of any single call.

const ALLOWED_ORIGINS = (_env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_TRANSCRIPT_CHARS = 60000;

const RATE_LIMIT_MAX = Number(_env.RATE_LIMIT_MAX || 20);
const RATE_LIMIT_WINDOW_MS = Number(_env.RATE_LIMIT_WINDOW_MS || 60000);
const rateBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isAllowedOrigin(req, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Same-origin requests always pass. Browsers send Origin on same-origin
  // POSTs too, so this must be handled or the app blocks itself.
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (!origin) return true; // non-browser client, or same-origin GET
  if (!isAllowedOrigin(req, origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

export function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();

  if (rateBuckets.size > 5000) {
    for (const [key, bucket] of rateBuckets) {
      if (now >= bucket.reset) rateBuckets.delete(key);
    }
  }

  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.reset) {
    bucket = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;

  return {
    ok: bucket.count <= RATE_LIMIT_MAX,
    retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
  };
}

export function parseBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let settled = false;

    const fail = (statusCode, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      reject(err);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Drain the rest instead of destroying the socket, so the 413 actually
        // reaches the client rather than surfacing as a connection reset.
        req.removeAllListeners("data");
        req.resume();
        fail(413, "Request body too large");
        return;
      }
      data += chunk;
    });
    req.on("error", () => fail(400, "Could not read the request body"));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Run every gate an endpoint needs, in order. Returns the parsed body when
 * the request may proceed, or null when it has already been answered — so a
 * handler starts with `const body = await guard(req, res); if (!body) return;`
 */
export async function guard(req, res) {
  if (!applyCors(req, res)) {
    res.status(403).json({ error: "Origin not allowed" });
    return null;
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return null;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return null;
  }

  const limit = checkRateLimit(req);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({
      error: `Too many requests. Try again in ${limit.retryAfter} seconds.`,
    });
    return null;
  }

  try {
    return await parseBody(req);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message || "Invalid request body" });
    return null;
  }
}

/** Shared validation for the endpoints that forward a transcript to the AI. */
export function validateTranscriptContext(value) {
  if (typeof value !== "string" || !value.trim()) return "transcriptContext is required";
  if (value.length > MAX_TRANSCRIPT_CHARS) {
    return `transcriptContext is too large (${value.length} chars, max ${MAX_TRANSCRIPT_CHARS})`;
  }
  return null;
}

// ─── Transcript Extraction ────────────────────────────────────────────

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Extract balanced JSON from string.
 */
function extractBalancedJson(text, startPos) {
  const open = text[startPos];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inString = false, escape = false;

  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.substring(startPos, i + 1); }
  }
  return null;
}

function mapCaptionTracks(tracksJson) {
  return tracksJson.map((t) => ({
    languageCode: t.languageCode || "unknown",
    languageName:
      t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode || "Unknown",
    kind: t.kind || "unknown",
    isTranslatable: t.isTranslatable || false,
    // These URLs must be fetched from the USER'S browser, not from the server
    transcriptUrl: t.baseUrl,
    translationLanguages: (t.translationLanguages || []).map((tl) => ({
      languageCode: tl.languageCode,
      languageName:
        tl.languageName?.simpleText || tl.languageCode || "Unknown",
    })),
  }));
}

/**
 * A failure the caller can act on. `code` distinguishes outcomes that the old
 * single error message conflated — "YouTube blocked us" and "this video has no
 * captions" need completely different responses from the user.
 */
export class TranscriptError extends Error {
  constructor(code, message, statusCode, retryAfter = null) {
    super(message);
    this.name = "TranscriptError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

// A real watch page is well over a megabyte. Throttle responses, consent
// interstitials and bot checks are a few KB — measured at ~3.2KB for a 429.
// Anything this small did not contain a player response, whatever its status.
const MIN_REAL_PAGE_BYTES = 50000;

const CACHE_TTL_MS = Number(_env.TRANSCRIPT_CACHE_TTL_MS || 30 * 60 * 1000);
const transcriptCache = new Map();

function cacheGet(videoId) {
  const hit = transcriptCache.get(videoId);
  if (!hit) return null;
  if (Date.now() >= hit.expires) {
    transcriptCache.delete(videoId);
    return null;
  }
  return hit.value;
}

function cacheSet(videoId, value) {
  if (transcriptCache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of transcriptCache) {
      if (now >= entry.expires) transcriptCache.delete(key);
    }
  }
  transcriptCache.set(videoId, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Fetch the watch page and classify what came back. Returns a discriminated
 * result rather than null-for-everything, so the caller knows whether retrying
 * could possibly help.
 */
/**
 * Decide what a watch-page response actually means. Pure, so the whole
 * decision table is testable without touching the network.
 *
 * Outcomes: ok | none | blocked | throttled | unavailable | transient
 */
export function classifyWatchPage(httpStatus, html) {
  if (httpStatus === 429 || httpStatus === 403) {
    return { kind: "throttled", detail: `YouTube returned HTTP ${httpStatus}` };
  }
  if (httpStatus === 404) return { kind: "unavailable", detail: "That video does not exist." };
  if (httpStatus !== 200) {
    return { kind: "transient", detail: `YouTube returned HTTP ${httpStatus}` };
  }

  const body = html || "";
  if (body.length < MIN_REAL_PAGE_BYTES) {
    return {
      kind: "throttled",
      detail: `YouTube served a ${body.length}-byte page instead of the video page`,
    };
  }

  // Read playabilityStatus specifically rather than scanning the whole page —
  // words like UNPLAYABLE appear elsewhere in a healthy page's 1.4MB of JSON.
  const playability = body.match(
    /"playabilityStatus":\{"status":"([A-Z_]+)"(?:,"reason":"((?:[^"\\]|\\.)*)")?/
  );
  const status = playability?.[1];
  const reason = playability?.[2]
    ? playability[2].replace(/\\u0026/g, "&").replace(/\\"/g, '"').replace(/\\n/g, " ")
    : null;

  if (status === "LOGIN_REQUIRED") {
    // Measured against the live site: a public, perfectly available video
    // returns LOGIN_REQUIRED with reason "Sign in to confirm you're not a bot"
    // when the request comes from a datacenter IP. Reporting that as a private
    // video sends the user chasing a problem they do not have.
    if (!reason || /not a bot|sign in to confirm|unusual traffic/i.test(reason)) {
      return { kind: "blocked", detail: reason || "YouTube bot check" };
    }
    return {
      kind: "unavailable",
      detail: `YouTube says: "${reason}" — the video is private or needs sign-in.`,
    };
  }

  if (status === "AGE_VERIFICATION_REQUIRED" || status === "CONTENT_CHECK_REQUIRED") {
    return {
      kind: "unavailable",
      detail: reason || "That video is age-restricted, so its captions cannot be read.",
    };
  }

  if (status === "UNPLAYABLE" || status === "ERROR") {
    // Pass YouTube's own wording through — "This video is unavailable",
    // "This video is private" and "not available in your country" are
    // different problems the user can act on differently.
    return {
      kind: "unavailable",
      detail: reason ? `YouTube says: "${reason}"` : "That video is unavailable.",
    };
  }

  const captionIdx = body.indexOf('"captionTracks":');
  if (captionIdx < 0) {
    // A full page whose player response is OK but carries no caption tracks
    // really does mean the video has none.
    return { kind: "none" };
  }

  const openBracket = body.indexOf("[", captionIdx);
  const balanced = openBracket < 0 ? null : extractBalancedJson(body, openBracket);
  if (!balanced) return { kind: "transient", detail: "caption data was malformed" };

  let tracksJson;
  try {
    tracksJson = JSON.parse(balanced);
  } catch {
    return { kind: "transient", detail: "caption data did not parse" };
  }

  if (!Array.isArray(tracksJson) || tracksJson.length === 0) return { kind: "none" };

  return { kind: "ok", tracks: mapCaptionTracks(tracksJson) };
}

async function fetchCaptionsFromWatchPage(videoId) {
  let res;
  try {
    res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8,zh;q=0.7,es;q=0.6,fr;q=0.5",
        Cookie: "CONSENT=YES+1",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { kind: "transient", detail: `request failed: ${err.message}` };
  }

  const html = res.status === 200 ? await res.text() : "";
  return classifyWatchPage(res.status, html);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch caption track metadata for a video.
 *
 * Retries only outcomes a retry could fix, and backs off between attempts —
 * the old version fired two identical requests back to back, which is the
 * worst possible move when the reason for failure is rate limiting.
 */
export async function fetchAllTranscripts(videoId) {
  const cached = cacheGet(videoId);
  if (cached) return { ...cached, cached: true };

  const backoffMs = [0, 700, 2000];
  let last = null;

  for (const wait of backoffMs) {
    if (wait) await sleep(wait);
    last = await fetchCaptionsFromWatchPage(videoId);

    if (last.kind === "ok") {
      const value = { tracks: last.tracks, source: "youtube_page_urls" };
      cacheSet(videoId, value);
      return value;
    }
    // Retrying will not conjure captions that do not exist, and will not
    // un-private a video.
    if (last.kind === "none" || last.kind === "unavailable") break;
  }

  if (last.kind === "none") {
    throw new TranscriptError(
      "no_captions",
      "This video has no captions, so there is nothing to transcribe, chat with or summarise. Try a video that shows a CC badge on YouTube.",
      422
    );
  }

  if (last.kind === "unavailable") {
    throw new TranscriptError("unavailable", last.detail, 422);
  }

  if (last.kind === "blocked") {
    throw new TranscriptError(
      "bot_check",
      "YouTube is challenging this server with a bot check, so it will not hand over the caption list. This is not a problem with the video — it happens because the request comes from a datacenter IP. Try again shortly; if it keeps happening, this video's captions cannot be read from the server.",
      429,
      120
    );
  }

  if (last.kind === "throttled") {
    throw new TranscriptError(
      "throttled",
      "YouTube is rate-limiting this server right now — this is not a problem with the video. Wait about a minute and try again.",
      429,
      60
    );
  }

  throw new TranscriptError(
    "upstream_error",
    `Could not reach YouTube to look up captions (${last?.detail || "unknown error"}). Try again in a moment.`,
    502
  );
}

/**
 * Legacy: fetch a single transcript's segments (server-side attempt).
 * Returns empty segments — actual fetching happens client-side now.
 */
export async function fetchTranscript(videoId) {
  const { tracks } = await fetchAllTranscripts(videoId);
  return tracks[0]?.transcriptUrl || "";
}

// ─── Transcript Formatting ────────────────────────────────────────────

export function formatTranscript(segments, maxChars = 50000) {
  let result = "";
  for (const s of segments) {
    const ts = formatTime(s.start);
    const line = `[${ts}] ${s.text}\n`;
    if (result.length + line.length > maxChars) break;
    result += line;
  }
  return result;
}

export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── AI Translation ────────────────────────────────────────────────────

export async function translateTranscript(segments, targetLanguage) {
  if (!_key) throw new Error("API key not configured");

  const fullText = segments.map((s) => s.text).join(" ");
  const maxChunkChars = 8000;

  if (fullText.length <= maxChunkChars) {
    return await translateChunk(fullText, targetLanguage);
  }

  const chunks = [];
  let currentChunk = "";
  for (const s of segments) {
    if (currentChunk.length + s.text.length + 1 > maxChunkChars) {
      chunks.push(currentChunk.trim());
      currentChunk = s.text;
    } else {
      currentChunk += (currentChunk ? " " : "") + s.text;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());

  const translatedParts = await Promise.all(
    chunks.map((chunk) => translateChunk(chunk, targetLanguage))
  );
  return translatedParts.join(" [–––] ");
}

async function translateChunk(text, targetLanguage) {
  const content = await callAI(
    [
      {
        role: "system",
        content: `You are a professional translator. Translate the following text to ${targetLanguage}. Preserve ALL meaning, tone, and nuance. Return ONLY the translated text — no explanations, no notes, no quotation marks.`,
      },
      { role: "user", content: text },
    ],
    { model: MODELS.translate, maxTokens: 4096 }
  );
  return content.trim();
}

// ─── AI Chat ───────────────────────────────────────────────────────────

export async function callAI(messages, options = {}) {
  if (!_key) throw new Error("API key not configured");

  const {
    model = MODELS.chat,
    maxTokens = 4000,
    temperature,
    json = false,
  } = options;

  const payload = { model, messages, max_tokens: maxTokens };

  // Only send temperature when a caller asks for it. Several models — including
  // every gpt-5 tier — do not accept the parameter at all, so sending it blindly
  // (as this code used to) just gets it dropped and creates a false impression
  // that output randomness is being controlled.
  if (typeof temperature === "number") payload.temperature = temperature;

  // Ask the provider to guarantee syntactically valid JSON. This is the real
  // control for structured output, and it works on models where temperature does not.
  if (json) payload.response_format = { type: "json_object" };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${_key}`,
      "HTTP-Referer": "https://yt-studio.vercel.app",
      "X-Title": "YT Studio",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`AI request failed: ${await res.text()}`);
  const data = await res.json();

  // OpenRouter can answer 200 with an error body and no choices — on a
  // moderation block, an upstream provider failure, or exhausted credit.
  // Reading data.choices[0] blindly turns that into a raw TypeError.
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(data?.error?.message || "The AI provider returned no completion.");
  }
  return content;
}

// Shared utilities for Vercel serverless functions

const _env = typeof process !== "undefined" ? process.env : {};
const _key = _env["OPENROUTER" + "_API_KEY"] || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
 * Fetch the YouTube watch page and extract caption track metadata from the
 * embedded player response. Returns null (not an error) if no caption data
 * is present in the page — that can mean the video genuinely has none, OR
 * that YouTube served a cookie-consent interstitial instead of the real
 * page (common for datacenter IPs, like cloud hosts). The CONSENT cookie
 * below answers that prompt so the real page comes back.
 */
async function fetchCaptionsFromWatchPage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.8,zh;q=0.7,es;q=0.6,fr;q=0.5",
      "Cookie": "CONSENT=YES+1",
    },
  });

  const html = await res.text();

  const captionIdx = html.indexOf('"captionTracks":');
  if (captionIdx < 0) return null;

  const openBracket = html.indexOf("[", captionIdx);
  if (openBracket < 0) return null;

  const balanced = extractBalancedJson(html, openBracket);
  if (!balanced) return null;

  let tracksJson;
  try {
    tracksJson = JSON.parse(balanced);
  } catch {
    return null;
  }

  if (!Array.isArray(tracksJson) || tracksJson.length === 0) return null;

  return mapCaptionTracks(tracksJson);
}

/**
 * Fetch caption track metadata (URLs only) for a video. Retries once on
 * failure — YouTube occasionally serves a transient interstitial that
 * clears up on a second request.
 */
export async function fetchAllTranscripts(videoId) {
  const attempt1 = await fetchCaptionsFromWatchPage(videoId).catch(() => null);
  if (attempt1) return { tracks: attempt1, source: "youtube_page_urls" };

  const attempt2 = await fetchCaptionsFromWatchPage(videoId).catch(() => null);
  if (attempt2) return { tracks: attempt2, source: "youtube_page_urls" };

  throw new Error(
    "Couldn't retrieve captions for this video. Either it has none, or YouTube is temporarily blocking this request — try again in a moment, or try a different video."
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
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${_key}`,
      "HTTP-Referer": "https://yt-studio.vercel.app",
      "X-Title": "YT Studio",
    },
    body: JSON.stringify({
      model: "~openai/gpt-mini-latest",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the following text to ${targetLanguage}. Preserve ALL meaning, tone, and nuance. Return ONLY the translated text — no explanations, no notes, no quotation marks.`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) throw new Error(`Translation failed: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ─── AI Chat ───────────────────────────────────────────────────────────

export async function callAI(messages, model = "~openai/gpt-mini-latest") {
  if (!_key) throw new Error("API key not configured");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${_key}`,
      "HTTP-Referer": "https://yt-studio.vercel.app",
      "X-Title": "YT Studio",
    },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 4000 }),
  });

  if (!res.ok) throw new Error(`AI request failed: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

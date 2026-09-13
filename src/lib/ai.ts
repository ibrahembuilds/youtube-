// OpenRouter AI client

const API_BASE = "/api";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface TranslationLanguage {
  languageCode: string;
  languageName: string;
}

export interface TranscriptTrack {
  languageCode: string;
  languageName: string;
  kind: string;
  isTranslatable: boolean;
  transcriptUrl: string;
  translationLanguages: TranslationLanguage[];
}

export interface TranscriptResult {
  tracks: TranscriptTrack[];
  source: string;
  totalTracks: number;
}

// ─── Server API calls ────────────────────────────────────────────────

/**
 * Why a transcript lookup failed. The UI reacts differently to each:
 * `throttled` is temporary and worth retrying, `no_captions` never will be.
 */
export type TranscriptErrorCode =
  | "throttled"
  | "bot_check"
  | "no_captions"
  | "unavailable"
  | "upstream_error"
  | "unknown";

export class TranscriptLookupError extends Error {
  code: TranscriptErrorCode;
  constructor(message: string, code: TranscriptErrorCode) {
    super(message);
    this.name = "TranscriptLookupError";
    this.code = code;
  }
}

/** Fetch track metadata (URLs only — no transcript content yet). */
export async function fetchTranscriptMeta(videoId: string): Promise<TranscriptResult> {
  const res = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new TranscriptLookupError(
      err.error || "Failed to look up captions for this video.",
      (err.code as TranscriptErrorCode) || "unknown"
    );
  }
  return res.json();
}

// ─── Client-side transcript fetching ──────────────────────────────────
// Captions must be fetched from the BROWSER, not the server: YouTube's signed
// caption URLs return HTTP 200 with an empty body to datacenter IPs (verified
// against a live signed URL), so anything running on Vercel gets nothing back.
//
// Order matters. The direct fetch goes first because YouTube's timedtext API
// does send CORS headers, and a direct fetch uses the viewer's own IP — which
// YouTube throttles far less aggressively than a datacenter one. The
// same-origin proxy is the fallback, then a public CORS proxy as last resort.

/** Build a same-origin proxy URL for YouTube's timedtext API. */
function makeProxyUrl(transcriptUrl: string): string {
  // Extract the query string from the YouTube URL
  const qIdx = transcriptUrl.indexOf("?");
  if (qIdx < 0) return transcriptUrl;
  const query = transcriptUrl.substring(qIdx); // includes "?"
  return `/yt-timedtext${query}`;
}

const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch a URL as text. Throws on a non-2xx status, an empty body, or a
 * timeout — so a caller can tell "this source failed" from "this source
 * returned something usable".
 */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("empty body");
  return text;
}

/** Fetch and parse a single transcript track from the browser. */
export async function fetchTranscriptContent(
  track: TranscriptTrack
): Promise<TranscriptSegment[]> {
  const sources: { label: string; load: () => Promise<TranscriptSegment[]> }[] = [
    {
      label: "direct",
      load: async () => parseTranscriptXml(await fetchText(track.transcriptUrl)),
    },
    {
      label: "direct-json3",
      load: async () => parseTranscriptJson3(await fetchText(track.transcriptUrl + "&fmt=json3")),
    },
    {
      label: "same-origin-proxy",
      load: async () => parseTranscriptXml(await fetchText(makeProxyUrl(track.transcriptUrl))),
    },
    {
      label: "cors-proxy",
      load: async () =>
        parseTranscriptXml(
          await fetchText(`https://api.allorigins.win/raw?url=${encodeURIComponent(track.transcriptUrl)}`)
        ),
    },
  ];

  const failures: string[] = [];

  for (const source of sources) {
    try {
      const segments = await source.load();
      // A 200 response is not success. Any same-origin path that is not
      // wired up returns the SPA's own index.html with HTTP 200, which
      // parses cleanly to zero segments — so only a non-empty parse counts.
      if (segments.length > 0) return segments;
      failures.push(`${source.label}: parsed 0 segments`);
    } catch (err) {
      failures.push(`${source.label}: ${(err as Error).message}`);
    }
  }

  throw new Error(`Could not load captions for ${track.languageName} — ${failures.join("; ")}`);
}

/** Fetch transcript content for ALL tracks in parallel from the browser. */
export async function fetchAllTranscriptContent(
  tracks: TranscriptTrack[]
): Promise<(TranscriptSegment[] | null)[]> {
  return Promise.all(
    tracks.map(async (track) => {
      try {
        return await fetchTranscriptContent(track);
      } catch {
        return null;
      }
    })
  );
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * Decode XML character references in a single pass.
 *
 * Chained .replace() calls corrupt each other: YouTube writes a literal "&"
 * as "&amp;amp;", and replacing /&amp;/ first turns that into "&amp;", which
 * no later rule can recover. One pass, repeated while the text still shrinks,
 * handles both single and double escaping.
 */
function decodeEntities(text: string): string {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      const named = XML_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Parse YouTube's XML transcript format into segments. */
export function parseTranscriptXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  // Match any <text ...> element and read its attributes by name, so a change
  // in attribute order or a missing dur does not silently drop the whole track.
  const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1];
    const start = parseFloat(/\bstart="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const duration = parseFloat(/\bdur="([^"]*)"/.exec(attrs)?.[1] ?? "");
    if (!Number.isFinite(start)) continue;

    // Caption text can carry inline markup; strip tags before decoding.
    const text = decodeEntities(match[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;

    segments.push({ text, start, duration: Number.isFinite(duration) ? duration : 0 });
  }

  return segments;
}

/**
 * Parse YouTube's JSON3 transcript format (fmt=json3).
 *
 * Shape matters here: timing is on the EVENT (tStartMs, dDurationMs) and each
 * segment carries only an offset from it (tOffsetMs). Reading seg.tStartMs —
 * which does not exist — made every segment start at 0:00.
 */
export function parseTranscriptJson3(json: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  try {
    const data = JSON.parse(json);
    const events = Array.isArray(data?.events) ? data.events : [];

    for (const event of events) {
      const eventStartMs = Number(event?.tStartMs) || 0;
      const eventDurationMs = Number(event?.dDurationMs) || 0;
      const segs = Array.isArray(event?.segs) ? event.segs : [];

      // Join a single event's segments into one line. YouTube splits a caption
      // into word-level pieces, and one segment per word is unusable both in
      // the transcript pane and as AI context.
      const text = decodeEntities(segs.map((seg: { utf8?: string }) => seg?.utf8 ?? "").join(""))
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;

      segments.push({
        text,
        start: eventStartMs / 1000,
        duration: eventDurationMs / 1000,
      });
    }
  } catch {
    // Malformed payload — return whatever parsed cleanly.
  }
  return segments;
}

/**
 * Render a timestamp the way YouTube does: m:ss under an hour, h:mm:ss over.
 * Without the hour case, 3725s printed as "62:05" — which the AI then quoted
 * back, and which no viewer can find in the player.
 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

export const MAX_AI_CONTEXT_CHARS = 50000;

/** Format segments into timestamped text for AI context. */
export function formatTranscriptText(segments: TranscriptSegment[]): string {
  let result = "";
  for (const s of segments) {
    const line = `[${formatTimestamp(s.start)}] ${s.text}\n`;
    if (result.length + line.length > MAX_AI_CONTEXT_CHARS) break;
    result += line;
  }
  return result;
}

/** How much of a transcript actually fits in the AI context. */
export function transcriptCoverage(segments: TranscriptSegment[]): {
  includedSegments: number;
  totalSegments: number;
  truncated: boolean;
  lastIncludedStart: number;
} {
  let used = 0;
  let included = 0;
  for (const s of segments) {
    const line = `[${formatTimestamp(s.start)}] ${s.text}\n`;
    if (used + line.length > MAX_AI_CONTEXT_CHARS) break;
    used += line.length;
    included++;
  }
  return {
    includedSegments: included,
    totalSegments: segments.length,
    truncated: included < segments.length,
    lastIncludedStart: included > 0 ? segments[included - 1].start : 0,
  };
}

// ─── Translation ──────────────────────────────────────────────────────

export async function translateTranscript(
  segments: TranscriptSegment[],
  targetLanguage: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments, targetLanguage }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Translation failed" }));
    throw new Error(err.error || "Translation failed");
  }
  const data = await res.json();
  return data.translatedText;
}

// ─── Chat ─────────────────────────────────────────────────────────────

export async function chatWithVideo(
  videoId: string,
  messages: ChatMessage[],
  transcriptContext: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, messages, transcriptContext }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Chat failed" }));
    throw new Error(err.error || "Chat failed");
  }
  return (await res.json()).response;
}

// ─── Summary ──────────────────────────────────────────────────────────

export async function generateSummary(
  videoId: string,
  transcriptContext: string,
  type: "brief" | "detailed" | "bullet" | "takeaways"
): Promise<string> {
  const res = await fetch(`${API_BASE}/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptContext, type }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: "Summary failed" }))).error);
  return (await res.json()).response;
}

// ─── Viral Shorts ─────────────────────────────────────────────────────

export async function generateViralShorts(
  videoId: string,
  transcriptContext: string
): Promise<ViralShort[]> {
  const res = await fetch(`${API_BASE}/viral`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptContext }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
  return (await res.json()).shorts;
}

export interface ViralShort {
  title: string;
  hook: string;
  startTime: number;
  endTime: number;
  script: string;
  captions: string[];
  hashtags: string[];
  thumbnailSuggestion: string;
  viralScore: number;
  reason: string;
}

// ─── Download ─────────────────────────────────────────────────────────

export async function getDownloadInfo(videoId: string): Promise<DownloadInfo> {
  const res = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
  return res.json();
}

export interface DownloadInfo {
  videoId: string;
  videoUrl: string;
  options: {
    label: string;
    desc: string;
    url: string;
    type: "external-tool" | "external";
  }[];
}

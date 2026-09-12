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

/** Fetch track metadata (URLs only — no transcript content yet). */
export async function fetchTranscriptMeta(videoId: string): Promise<TranscriptResult> {
  const res = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch transcript" }));
    throw new Error(err.error || "Failed to fetch transcript");
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

/** Parse YouTube's XML transcript format into segments. */
export function parseTranscriptXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>(.*?)<\/text>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const text = match[3]
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;amp;/g, "&")
      .trim();
    if (text) {
      segments.push({
        text,
        start: parseFloat(match[1]),
        duration: parseFloat(match[2]),
      });
    }
  }

  return segments;
}

/** Parse YouTube's JSON3 transcript format (fmt=json3). */
export function parseTranscriptJson3(json: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  try {
    const data = JSON.parse(json);
    const events = data.events || [];
    for (const event of events) {
      const segs = event.segs || [];
      for (const seg of segs) {
        const text = (seg.utf8 || "").replace(/\n/g, " ").trim();
        if (text) {
          segments.push({
            text,
            start: (seg.tStartMs || 0) / 1000,
            duration: ((seg.dDurationMs || seg.tStartMs || 0) - (seg.tStartMs || 0)) / 1000 || 2,
          });
        }
      }
    }
  } catch {
    // Return whatever we parsed
  }
  return segments;
}

/** Format segments into timestamped text for AI context. */
export function formatTranscriptText(segments: TranscriptSegment[]): string {
  let result = "";
  for (const s of segments) {
    const m = Math.floor(s.start / 60);
    const sec = Math.floor(s.start % 60);
    const ts = `${m}:${sec.toString().padStart(2, "0")}`;
    const line = `[${ts}] ${s.text}\n`;
    if (result.length + line.length > 50000) break;
    result += line;
  }
  return result;
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
  title: string;
  videoId: string;
  options: { label: string; desc: string; url: string; type: "video" | "audio" | "external" }[];
}

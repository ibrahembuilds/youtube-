import { guard } from "./_lib.js";
import { youtubeFetch, mintCaptionToken, resetCaptionMinter, YT_USER_AGENT } from "./_youtube.js";

// Vercel caps a function response at 4.5MB. A long video's json3 is well
// under 1MB; anything near the cap is not a caption file.
const MAX_CAPTION_BYTES = 4 * 1024 * 1024;

/**
 * Turn a caption track's baseUrl into the request that actually returns
 * text. Returns null for anything that is not a timedtext URL for this exact
 * video, so this endpoint can never be used to fetch arbitrary URLs through
 * the server (or through the paid proxy behind it).
 */
export function buildCaptionUrl(transcriptUrl, videoId, poToken) {
  if (typeof transcriptUrl !== "string" || transcriptUrl.length > 4096) return null;
  let url;
  try {
    url = new URL(transcriptUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com") return null;
  if (url.pathname !== "/api/timedtext") return null;
  if (url.username || url.password || url.port) return null;
  if (url.searchParams.get("v") !== videoId) return null;

  url.searchParams.set("fmt", "json3");
  if (poToken) {
    // c=WEB is required alongside pot; without it the reply is empty again.
    url.searchParams.set("pot", poToken);
    url.searchParams.set("c", "WEB");
  }
  return url.href;
}

/** exp=xpe caption URLs are empty unless a PO token is attached. Others download as-is. */
export function captionUrlNeedsPoToken(transcriptUrl) {
  try {
    return new URL(transcriptUrl).searchParams.get("exp") === "xpe";
  } catch {
    return false;
  }
}

async function pullCaption(videoId, transcriptUrl, poToken) {
  let upstream;
  try {
    upstream = await youtubeFetch(buildCaptionUrl(transcriptUrl, videoId, poToken), {
      headers: { "User-Agent": YT_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { error: "reach", detail: err.message };
  }
  if (upstream.status === 429 || upstream.status === 403) return { error: "throttled" };
  if (!upstream.ok) return { error: "status", status: upstream.status };
  return { text: await upstream.text() };
}

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { videoId, transcriptUrl } = body;

  if (typeof videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "videoId is not a valid YouTube id" });
  }
  if (!buildCaptionUrl(transcriptUrl, videoId, null)) {
    return res.status(400).json({ error: "transcriptUrl must be this video's YouTube caption URL" });
  }

  // Only exp=xpe URLs need a PO token. The iOS player hands back URLs
  // without that flag, and those download as-is. A URL that still needs a
  // token is retried once with a fresh minter — a warm instance can cache
  // a minter whose tokens YouTube has started rejecting.
  const needsPot = captionUrlNeedsPoToken(transcriptUrl);
  let poToken = null;
  if (needsPot) {
    try {
      poToken = await mintCaptionToken(videoId);
    } catch (err) {
      console.error(`PO token mint failed for ${videoId}: ${err.message}`);
    }
  }

  let result = await pullCaption(videoId, transcriptUrl, poToken);
  if (needsPot && result.text !== undefined && !result.text.trim()) {
    console.error(`Empty caption body for ${videoId} (token ${poToken ? "sent" : "missing"}), minting again`);
    resetCaptionMinter();
    try {
      poToken = await mintCaptionToken(videoId);
      result = await pullCaption(videoId, transcriptUrl, poToken);
    } catch (err) {
      console.error(`PO token remint failed for ${videoId}: ${err.message}`);
    }
  }

  if (result.error === "reach") {
    console.error(`Caption fetch failed for ${videoId}: ${result.detail}`);
    return res.status(502).json({ error: "Could not reach YouTube for this caption track.", code: "upstream_error" });
  }
  if (result.error === "throttled") {
    return res.status(429).json({ error: "YouTube is rate-limiting caption requests. Try again shortly.", code: "throttled" });
  }
  if (result.error === "status") {
    return res.status(502).json({ error: `YouTube returned HTTP ${result.status} for this caption track.`, code: "upstream_error" });
  }

  const text = result.text || "";
  if (!text.trim()) {
    // The exp=xpe signature: 200 with nothing in it. Saying so here is what
    // separates "token rejected" from "no captions" in the logs.
    console.error(`Empty caption body for ${videoId} (token ${poToken ? "sent" : "missing"})`);
    return res.status(502).json({ error: "YouTube returned an empty caption file.", code: "empty_captions" });
  }
  if (Buffer.byteLength(text) > MAX_CAPTION_BYTES) {
    return res.status(502).json({ error: "The caption file was unexpectedly large.", code: "upstream_error" });
  }

  res.json({ format: "json3", body: text });
}

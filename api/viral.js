import { guard, callAI, validateTranscriptContext, MODELS } from "./_lib.js";

/**
 * Pull a JSON object out of a model response.
 *
 * response_format asks the provider for valid JSON, but not every provider
 * honours it perfectly and a model can still wrap the object in a markdown
 * fence or a sentence of preamble. The old code ran JSON.parse on the raw
 * string, so any of that surfaced to the user as a parse error. Strip the
 * common wrappers, then fall back to scanning for the first balanced object.
 */
export function extractJsonObject(raw) {
  let text = String(raw || "").trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // fall through to scanning
  }

  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Short-form platforms cap out around a minute, and nothing under ~10 seconds
// is a publishable clip. Measured against the live endpoint, the model returned
// 4-second clips on a long transcript and a 112-second one on a short
// transcript when the prompt said nothing about duration.
export const MIN_CLIP_SECONDS = 10;
export const MAX_CLIP_SECONDS = 90;

/** Keep only entries that have the fields the UI actually renders. */
export function normaliseShorts(parsed) {
  const list = Array.isArray(parsed?.shorts) ? parsed.shorts : [];
  return list
    .filter((s) => s && typeof s.title === "string" && typeof s.script === "string")
    .map((s) => ({
      title: s.title,
      hook: typeof s.hook === "string" ? s.hook : "",
      startTime: Number.isFinite(+s.startTime) ? +s.startTime : 0,
      endTime: Number.isFinite(+s.endTime) ? +s.endTime : 0,
      script: s.script,
      captions: Array.isArray(s.captions) ? s.captions.filter((c) => typeof c === "string") : [],
      hashtags: Array.isArray(s.hashtags) ? s.hashtags.filter((h) => typeof h === "string") : [],
      thumbnailSuggestion: typeof s.thumbnailSuggestion === "string" ? s.thumbnailSuggestion : "",
      viralScore: Number.isFinite(+s.viralScore) ? Math.max(0, Math.min(100, +s.viralScore)) : 0,
      reason: typeof s.reason === "string" ? s.reason : "",
    }))
    .filter((s) => {
      const span = s.endTime - s.startTime;
      return span >= MIN_CLIP_SECONDS && span <= MAX_CLIP_SECONDS;
    });
}

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { transcriptContext } = body;

  const contextError = validateTranscriptContext(transcriptContext);
  if (contextError) return res.status(400).json({ error: contextError });

  try {
    const systemPrompt = `You are a viral content strategist who specializes in creating short-form content (Reels, TikTok, YouTube Shorts) from long-form YouTube videos.

Analyze the transcript and identify 3-5 moments that would make the best viral short-form clips. For each clip, provide:

1. A scroll-stopping title (max 60 chars)
2. A compelling hook (the first 3 seconds of the short)
3. Start time and end time in SECONDS as numbers, taken from the transcript timestamps.
   CRITICAL: each clip must run between 20 and 60 seconds (endTime - startTime).
   That is the format's limit — Reels, TikTok and Shorts need a complete beat,
   not a single sentence. A 5-second clip is unusable, and so is a 2-minute one.
   Span several consecutive transcript lines to reach a real 20-60 second moment.
4. A script for the short (adapted from the transcript, optimized for short-form)
5. On-screen captions (array of short text overlays)
6. Hashtags (5-10 relevant hashtags)
7. Thumbnail suggestion (visual description of what the thumbnail should look like)
8. Viral score (1-100, based on hook strength, emotional impact, and shareability)
9. Why this clip would go viral (brief explanation)

Respond with a JSON object in exactly this shape:
{
  "shorts": [
    {
      "title": "...",
      "hook": "...",
      "startTime": 0,
      "endTime": 0,
      "script": "...",
      "captions": ["...", "..."],
      "hashtags": ["...", "..."],
      "thumbnailSuggestion": "...",
      "viralScore": 85,
      "reason": "..."
    }
  ]
}

Write the content in the same language as the transcript.

Before returning, check every clip: if endTime - startTime is under 20 or over
60, widen or tighten the window until it fits.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here is the video transcript with timestamps:\n\n${transcriptContext}` },
    ];

    // json mode is the control that actually works here — the gpt-5 tiers do
    // not accept a temperature parameter at all. Output needs headroom too:
    // five shorts with scripts truncate at 4000 tokens, and a truncated
    // response is invalid JSON.
    const response = await callAI(messages, {
      model: MODELS.viral,
      maxTokens: 8000,
      json: true,
    });

    const parsed = extractJsonObject(response);
    if (!parsed) {
      console.error("Viral shorts: model did not return parseable JSON");
      return res.status(502).json({
        error: "The AI returned a malformed response. Please try again.",
      });
    }

    const shorts = normaliseShorts(parsed);
    if (shorts.length === 0) {
      return res.status(502).json({
        error:
          "The AI did not return any clips of a usable length for short-form video. Please try again.",
      });
    }

    res.json({ shorts });
  } catch (err) {
    console.error("Viral shorts error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate viral shorts" });
  }
}

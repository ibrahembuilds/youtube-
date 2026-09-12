import { guard, callAI, validateTranscriptContext } from "./_lib.js";

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
3. Start time and end time (from the transcript timestamps)
4. A script for the short (adapted from the transcript, optimized for short-form)
5. On-screen captions (array of short text overlays)
6. Hashtags (5-10 relevant hashtags)
7. Thumbnail suggestion (visual description of what the thumbnail should look like)
8. Viral score (1-100, based on hook strength, emotional impact, and shareability)
9. Why this clip would go viral (brief explanation)

Return ONLY valid JSON in this format:
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

IMPORTANT: Return ONLY the JSON, no markdown, no explanation before or after.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here is the video transcript with timestamps:\n\n${transcriptContext}` },
    ];

    const response = await callAI(messages);

    // Parse JSON from response (handle markdown code blocks)
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(cleaned);

    res.json(parsed);
  } catch (err) {
    console.error("Viral shorts error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate viral shorts" });
  }
}

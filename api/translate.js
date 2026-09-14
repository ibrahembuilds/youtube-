import { guard, translateTranscript, MAX_TRANSCRIPT_CHARS } from "./_lib.js";

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { segments, targetLanguage } = body;

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "segments array is required" });
  }
  if (segments.some((segment) => !segment || typeof segment.text !== "string" || !segment.text.trim())) {
    return res.status(400).json({ error: "Each segment must contain non-empty text" });
  }
  const totalChars = segments.reduce((n, s) => n + String(s?.text ?? "").length, 0);
  if (totalChars > MAX_TRANSCRIPT_CHARS) {
    return res.status(400).json({
      error: `Transcript is too large to translate (${totalChars} chars, max ${MAX_TRANSCRIPT_CHARS})`,
    });
  }
  if (typeof targetLanguage !== "string" || !targetLanguage.trim() || targetLanguage.length > 80) {
    return res.status(400).json({ error: "targetLanguage is required (e.g. 'Arabic', 'Spanish', 'Chinese')" });
  }

  try {
    const translatedText = await translateTranscript(segments, targetLanguage);

    res.json({
      translatedText,
      targetLanguage,
      sourceSegmentCount: segments.length,
    });
  } catch (err) {
    console.error("Translation error:", err.message);
    res.status(500).json({ error: err.message || "Translation failed" });
  }
}

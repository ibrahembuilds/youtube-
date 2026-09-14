import { guard, callAI, validateTranscriptContext, MODELS } from "./_lib.js";

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { messages, transcriptContext } = body;

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array is required" });
  if (messages.length > 20) return res.status(400).json({ error: "Too many messages (maximum 20)" });
  if (messages.some((message) => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 4000)) {
    return res.status(400).json({ error: "Each message must be a user or assistant message of 4,000 characters or fewer" });
  }
  const contextError = validateTranscriptContext(transcriptContext);
  if (contextError) return res.status(400).json({ error: contextError });

  try {
    const systemPrompt = `You are an AI assistant that helps users understand YouTube videos. 
You have access to the video's transcript with timestamps. 
Answer questions about the video content accurately and in detail.
When referencing specific parts, include the timestamp.
Detect the user's language and respond in the same language they use.

VIDEO TRANSCRIPT:
${transcriptContext}`;

    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const response = await callAI(aiMessages, { model: MODELS.chat });
    res.json({ response });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message || "Chat failed" });
  }
}

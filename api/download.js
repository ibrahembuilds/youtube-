import { guard } from "./_lib.js";

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { videoId } = body;

  if (!videoId) return res.status(400).json({ error: "videoId is required" });

  try {
    // Fetch video page to get streamingData
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageRes = await fetch(videoUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await pageRes.text();

    // Extract title
    const titleMatch = html.match(/<title>(.*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(" - YouTube", "") : `Video ${videoId}`;

    // Since direct download URLs from YouTube are encrypted and expire quickly,
    // we return download options via third-party services
    res.json({
      title,
      videoId,
      options: [
        {
          label: "Video (MP4)",
          desc: "Opens cobalt.tools in a new tab — paste the video link there to download",
          url: "https://cobalt.tools/",
          type: "video",
        },
        {
          label: "Audio Only (MP3)",
          desc: "Opens cobalt.tools in a new tab — paste the link there and choose audio",
          url: "https://cobalt.tools/",
          type: "audio",
        },
        {
          label: "Open in YouTube",
          desc: "Watch directly on YouTube",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: "external",
        },
      ],
    });
  } catch (err) {
    console.error("Download error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get download info" });
  }
}

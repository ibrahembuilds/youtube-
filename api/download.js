import { guard } from "./_lib.js";

// Why there is no real "download" here:
//
// YouTube's audio and video stream URLs are signature-ciphered. Verified
// against a live watch page — all four audio formats (itag 140/249/250/251)
// came back with a signatureCipher and no plain url. Resolving those means
// running YouTube's rotating JavaScript cipher, which is a permanent
// maintenance treadmill and cannot run inside a serverless function anyway.
//
// The cobalt.tools API is not an option either: the v7 API shut down on
// 2024-11-11, and cobalt.tools ignores a pre-filled ?u= parameter (it serves
// the identical homepage), so we cannot hand it the video for the user.
//
// So this endpoint hands back an honest set of links instead of two
// identically-pointed ones labelled "MP4" and "MP3" that download nothing.

export default async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const { videoId } = body;

  if (!videoId) return res.status(400).json({ error: "videoId is required" });
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "videoId is not a valid YouTube id" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // No watch-page fetch here. It existed only to scrape <title>, it cost a
  // 1.4MB download per request, it is subject to the same bot-check that
  // blocks caption lookups, and the client already has the real title from
  // oEmbed.
  res.json({
    videoId,
    videoUrl,
    options: [
      {
        label: "Download with cobalt.tools",
        desc: "Opens cobalt.tools. Paste the link above and pick video or audio there.",
        url: "https://cobalt.tools/",
        type: "external-tool",
      },
      {
        label: "Open in YouTube",
        desc: "Watch or download using YouTube Premium.",
        url: videoUrl,
        type: "external",
      },
    ],
  });
}

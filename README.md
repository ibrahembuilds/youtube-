# YT Studio

Paste a YouTube link. Watch, chat, summarize, and create viral shorts from any video.

## Features

- 🎬 **Watch** any YouTube video with embedded player
- 💬 **Chat** with the video — ask any question, get AI answers with timestamps
- 📝 **Summarize** — brief, detailed, bullet points, or key takeaways
- ✂️ **Viral Shorts** — AI finds the best clips, writes scripts, captions, hashtags & thumbnail ideas
- 📥 **Download** video or audio-only

## Tech Stack

- React + Vite + TypeScript
- Tailwind CSS (clean minimal design)
- Vercel Serverless Functions (API)
- OpenRouter for AI (model per task, set by env var)
- YouTube timedtext API for transcripts

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and add your OpenRouter API key
4. `npm run dev` — starts the Vite dev server (port 3000) and a local API server (port 3001) together
5. Deploy to Vercel — set `OPENROUTER_API_KEY` in Vercel env vars

`npm run dev` reads `.env` via `api-server.js` (a local stand-in for Vercel's serverless functions, used only in development). In production on Vercel, the files in `api/` run as real serverless functions instead.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | Powers chat, summaries, viral shorts and translation. |
| `AI_MODEL_CHAT` | no | Model for chat (default `openai/gpt-5-nano`). |
| `AI_MODEL_SUMMARY` | no | Model for summaries (default `openai/gpt-5-nano`). |
| `AI_MODEL_VIRAL` | no | Model for viral shorts (default `openai/gpt-5-mini`). |
| `AI_MODEL_TRANSLATE` | no | Model for translation (default `openai/gpt-5-mini`). |
| `ALLOWED_ORIGINS` | no | Extra browser origins allowed to call `/api/*`. Same-origin is always allowed. |
| `RATE_LIMIT_MAX` | no | Per-IP requests per window (default 20). |
| `RATE_LIMIT_WINDOW_MS` | no | Window length in ms (default 60000). |

The rate-limit counter lives in each serverless instance's memory, so the real
ceiling is `warm instances x RATE_LIMIT_MAX`. Use a shared store (Redis/Upstash)
if you need a hard cap.

## Tests

```bash
npm test            # units + api + e2e
npm run test:unit   # caption parsers, imported from src/
npm run test:api    # /api contract, CORS, rate limits — spawns its own server
npm run test:e2e    # real Chromium against a production build
```

The E2E suite runs against a production build served through the rewrite rules
in this repo's own `vercel.json`, because dev and production route
`/yt-timedtext` differently and that gap is where transcript bugs hide. See
[`tests/README.md`](tests/README.md) for the known-issue tagging scheme.

## License

MIT

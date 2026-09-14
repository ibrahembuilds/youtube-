# Verification

Verified on 2026-09-14 using the production Vite build, local API server, and Chromium 153.

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Unit | 68 | 0 |
| Reliability | 8 | 0 |
| API | 31 | 0 |
| Browser workflows | 60 | 0 |
| Language rendering | 18 | 0 |
| **Total** | **185** | **0** |

Run the complete suite with `CHROME_PATH=/path/to/chromium npm test`. Production build, ESLint, and `git diff --check` also pass.

## Coverage

- History persists after reload, deduplicates videos, preserves bookmarks, supports search and reopening, and persists deletion. Invalid or unavailable browser storage is handled visibly.
- Caption fallback, empty responses, and timeouts; transcript search, timestamp seeking, complete text export, and translation target changes.
- Chat, summary, and clip generation success, failure, and retry; stale responses from an earlier video are discarded.
- API validation, already-parsed serverless request bodies, split UTF-8 input, provider timeouts and invalid/truncated responses, translation chunk ordering, CORS and rate limits.
- Empty and loaded layouts at 1440, 768, 390, and 320 pixels; eight writing systems on desktop and mobile, including Arabic and Hebrew right-to-left rendering.
- Screenshot evidence is in `docs/screenshots/`. Browser screenshots use fixture video/caption data.

## Live integration limits

Browser workflow tests use controlled caption, metadata, and AI responses so success and error paths are reproducible. They do not prove live YouTube playback or AI provider availability.

The API suite exercises live YouTube caption-track discovery and caching. A separate live probe for `dQw4w9WgXcQ` found six caption tracks, but fetching the first track from this environment returned HTTP 200 with an empty body. Consequently, live caption text retrieval could not be verified here. The application detects empty caption responses, tries alternatives, and shows a recoverable error when none work. Caption availability remains dependent on YouTube and the viewer's network.

No OpenRouter key was configured for live AI calls. Provider behavior is covered with fixtures; a deployment with `OPENROUTER_API_KEY` must still be checked against the real provider.

History stores video metadata and bookmarks in this browser, not video files or generated AI results. Reopening videos requires internet access. Text exports download locally; the Download tool offers external services rather than a built-in video downloader. Viral Shorts generates scripts and clip suggestions, not rendered video files.

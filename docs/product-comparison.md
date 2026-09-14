# Product comparison and UI decisions

Reviewed 14 September 2026. Competitor capabilities below come from their official product pages, not independent performance tests. No pricing or accuracy claims are used.

| Product | Advertised emphasis | Useful pattern for YT Studio |
| --- | --- | --- |
| [NoteGPT](https://notegpt.io/youtube-video-summarizer) | Video summaries, translation, batch inputs, and saved notes | Organize repeat visits in a dedicated workspace rather than making every visit start from scratch. |
| [Eightify](https://eightify.app/) | Concise insights, timestamp navigation, translations, and sharing | Keep the video visible while the user reads and explores; make timestamps actionable. |
| [Tactiq YouTube Transcript](https://tactiq.io/tools/youtube-transcript) | Paste a video link, view a transcript, copy or download its text | Make getting usable text out of the tool an obvious, direct action. |

## Implemented direction

- A restrained violet accent, readable neutral text, consistent controls, a desktop sidebar, and compact mobile navigation.
- A persistent video panel alongside transcript and AI tools on wide screens; stacked layout on phones/tablets.
- A local History section with title/channel search, deduplicated recent visits, dates, removal, and bookmarks in Saved.
- Transcript search, timestamp seeking, and full text exports. Export is independent of the active search filter.
- Summary and clip-script text export, visible errors, retries, and request isolation when the user changes videos.
- Clear labels about what the product actually delivers: clip plans and text, not a rendered video file or a guaranteed viral result.

## Deliberate limits

History stores up to 100 lightweight records in versioned browser localStorage: video ID, title, channel, visit time, and bookmark state. It does not store video files, signed caption URLs, transcripts, chats, summaries, or translations, and does not sync across devices. Clearing browser data removes history. Storage errors remain visible while the rest of the app works.

The app still depends on YouTube allowing access to captions/embedded playback and on the deployment having a valid OpenRouter key and provider credit. No UI change removes those dependencies. Batch processing, audio transcription for captionless videos, cloud workspaces, and rendered clip export are outside this implementation.

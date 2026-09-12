# Tests

No framework — three plain Node scripts. `npm test` runs all three.

| Command | What it covers |
| --- | --- |
| `npm run test:unit` | The caption parsers, imported directly from `src/lib/ai.ts` (Node strips the types, no build step). |
| `npm run test:api` | `/api/*` contract, CORS, rate limiting and payload caps. Spawns its own `api-server.js` instances, so nothing needs to be running first. |
| `npm run test:e2e` | Real Chromium against a **production build**, served through the rewrite rules in the project's own `vercel.json`. |

## Why E2E runs against the production build

The bug that motivated this suite only existed in production. `vite.config.ts`
proxies `/yt-timedtext` to YouTube in development; Vercel only does that if
`vercel.json` says so. When it didn't, that path returned the app's own
`index.html` with HTTP 200, the fetch chain accepted it as a transcript, parsed
zero segments and stopped — so every AI feature silently had nothing to work
with, while the dev server looked perfectly healthy.

`tests/prod-server.mjs` reads the real `vercel.json` and applies its rewrites
(filesystem first, then rules in order, first match wins — Vercel's own
semantics). Deleting the `/yt-timedtext` rule fails the suite.

## Known issues

A check can be tagged with the finding it is known to fail:

```js
check("keeps hour-long videos unambiguous", text.includes("[1:02:05]"),
  "3725s renders as 62:05", "F06");
```

Tagged failures report as `KNOWN` and do not fail the run, so the suite stays
green on today's code while still documenting what is broken. The tag fails in
both directions:

- an **untagged** check that fails is a regression → non-zero exit
- a **tagged** check that passes reports `FIXED` → remove the tag

Open tags: F04 (json3 timestamps), F05 (summary type), F06 (hour timestamps),
F07 (double-escaped entities), F10 (badge honesty), F11 (chat gating),
F13 (silent truncation), F16 (attribute-order parsing), F17 (no 404 route).

## Browser binary

`test:e2e` uses Playwright's own Chromium. Install once with
`npx playwright install chromium`, or point `CHROME_PATH` at an existing build.

## Network

`test:unit` and `test:e2e` are hermetic — every external host is stubbed.
`test:api` makes live calls to YouTube. Those checks assert that whatever
comes back is *classified* — throttling, no captions, unavailable video — so
the suite passes whether or not YouTube is rate-limiting at the time.

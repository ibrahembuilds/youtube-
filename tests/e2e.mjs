// Browser end-to-end checks, run against a PRODUCTION build served through the
// project's real vercel.json rewrites (see prod-server.mjs). Dev-only proxies
// are deliberately absent here — that gap is what shipped broken before.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { group, check, summarise } from "./harness.mjs";
import { startProdServer, resolveRewrite } from "./prod-server.mjs";

const PORT = 4173;
const API_PORT = 3103;
const BASE = `http://localhost:${PORT}`;
// Prefer an explicit CHROME_PATH, then any browser already provisioned under
// PLAYWRIGHT_BROWSERS_PATH (CI images usually pre-install one, and its build
// number will not match whatever Playwright version is in package.json).
// Falling through to null lets Playwright resolve its own download, which is
// what happens on a dev machine after `npx playwright install chromium`.
function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;

  const candidates = [
    "chrome-linux/chrome",
    "chrome-linux64/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win/chrome.exe",
  ];
  for (const dir of fs.readdirSync(root)) {
    if (!dir.startsWith("chromium-")) continue;
    for (const rel of candidates) {
      const candidate = path.join(root, dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const CHROME = findChrome();

const XML = `<?xml version="1.0" encoding="utf-8"?><transcript>
<text start="0.5" dur="3.2">Welcome to the show</text>
<text start="65.8" dur="4.1">The first key point is consistency</text>
<text start="3725.0" dur="2.5">And that is a wrap</text></transcript>`;

const TRACK_URL = "https://www.youtube.com/api/timedtext?v=TEST1234567&lang=en";
const META = {
  tracks: [{
    languageCode: "en", languageName: "English", kind: "asr", isTranslatable: true,
    transcriptUrl: TRACK_URL, translationLanguages: [],
  }],
  source: "youtube_page_urls", totalTracks: 1,
};

function startApi() {
  const child = spawn("node", ["api-server.js"], {
    env: { ...process.env, API_PORT: String(API_PORT), RATE_LIMIT_MAX: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    const t = setTimeout(
      () => reject(new Error(`api server did not start on :${API_PORT}\n${stderr.trim()}`)),
      15000
    );
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      if (d.toString().includes("API dev server running")) { clearTimeout(t); resolve(child); }
    });
    child.on("error", reject);
  });
}

const api = await startApi();
const prod = await startProdServer({ port: PORT, apiPort: API_PORT });
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

/**
 * Fresh page with every external host stubbed. `sources` decides what each
 * transcript source returns, so a test can force the fetch chain down a
 * specific path and record the order the app actually tried them in.
 */
async function newPage({ sources = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const order = [];
  const errors = [];

  page.on("pageerror", (e) => errors.push(e.message));

  const reply = (route, spec) => {
    if (!spec || spec === "fail") return route.fulfill({ status: 500, body: "" });
    if (spec === "spa-shell") return route.fulfill({ status: 200, contentType: "text/html", body: SPA_HTML });
    if (spec === "empty") return route.fulfill({ status: 200, contentType: "text/xml", body: "" });
    if (spec === "hang") return new Promise(() => {}); // never resolves
    return route.fulfill({ status: 200, contentType: "text/xml", body: spec });
  };

  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) && !url.includes("/yt-timedtext")) return route.continue();

    if (url.includes("/yt-timedtext")) { order.push("same-origin-proxy"); return reply(route, sources.proxy); }
    if (url.includes("allorigins")) { order.push("cors-proxy"); return reply(route, sources.cors); }
    if (url.includes("/api/timedtext") && url.includes("fmt=json3")) { order.push("direct-json3"); return reply(route, sources.directJson3); }
    if (url.includes("/api/timedtext")) { order.push("direct"); return reply(route, sources.direct); }

    if (url.includes("/oembed")) return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ title: "Test Video", author_name: "Test Channel", author_url: "", thumbnail_url: "" }) });
    if (url.includes("/embed/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.route(`${BASE}/api/transcript`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(META) }));

  page.__order = order;
  page.__errors = errors;
  return { ctx, page };
}

const SPA_HTML = await (await fetch(`${BASE}/index.html`)).text();

async function loadVideo(page) {
  await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
  await page.fill("input[placeholder='Paste YouTube link here...']", "https://www.youtube.com/watch?v=TEST1234567");
  await page.click("button:has-text('Load Video')");
  await page.waitForSelector("button:has-text('Transcript')", { timeout: 25000 });
  await page.click("button:has-text('Transcript')");
  await page.waitForTimeout(700);
}

// The transcript is a list of rows (timestamp cell + caption cell), not one
// pre-wrapped block, so read the whole scrolling container.
const transcriptText = (page) =>
  page.locator(".card.p-6 .overflow-y-auto").first().textContent().catch(() => "");

try {
  group("F01 — routing");
  {
    const hit = resolveRewrite("/yt-timedtext");
    check("vercel.json routes /yt-timedtext off-site, not to index.html",
      hit.external && hit.destination.includes("youtube.com"),
      `resolves to ${hit.destination} — without this rule the SPA shell is served with HTTP 200`);

    const res = await fetch(`${BASE}/yt-timedtext?v=x&lang=en`);
    check("the served app agrees", res.headers.get("x-rewrite-external") === "true",
      `x-rewrite-target=${res.headers.get("x-rewrite-target")}`);
  }

  group("F01 — the fetch chain validates what it gets");
  {
    // The original bug: any HTTP 200 ended the chain. An unrouted same-origin
    // path returns the SPA's own HTML, which parses cleanly to zero segments.
    const { ctx, page } = await newPage({
      sources: { direct: "fail", directJson3: "fail", proxy: "spa-shell", cors: XML },
    });
    await loadVideo(page);
    const body = await transcriptText(page);
    check("an HTML shell is rejected, not accepted as an empty transcript",
      /Welcome to the show/.test(body),
      `order=${JSON.stringify(page.__order)} body=${JSON.stringify((body || "").slice(0, 80))}`);
    check("it kept going after the shell and reached a working source",
      page.__order.includes("cors-proxy"),
      `order=${JSON.stringify(page.__order)} — the chain stopped early`);
    await ctx.close();
  }

  group("F01 — source ordering");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    check("tries the direct browser fetch first",
      page.__order[0] === "direct",
      `order=${JSON.stringify(page.__order)} — the viewer's own IP is the least throttled path`);
    check("stops as soon as a source works", page.__order.length === 1,
      `order=${JSON.stringify(page.__order)}`);
    await ctx.close();
  }

  group("F01 — an empty body is a failure, not a transcript");
  {
    // YouTube answers datacenter IPs with 200 and a zero-length body.
    const { ctx, page } = await newPage({
      sources: { direct: "empty", directJson3: "empty", proxy: "empty", cors: XML },
    });
    await loadVideo(page);
    check("falls through 200-with-empty-body responses",
      /Welcome to the show/.test(await transcriptText(page)),
      `order=${JSON.stringify(page.__order)}`);
    await ctx.close();
  }

  group("F01 — failure is visible, never silent");
  {
    const { ctx, page } = await newPage({
      sources: { direct: "fail", directJson3: "fail", proxy: "fail", cors: "fail" },
    });
    await loadVideo(page);
    const shown = await page.locator("text=Could not load transcript").count();
    check("all sources failing shows an explicit empty state", shown > 0,
      "the user must not be left with a silently blank transcript");
    check("every source was attempted", page.__order.length === 4,
      `order=${JSON.stringify(page.__order)}`);
    await ctx.close();
  }

  group("F01 — a hung source cannot wedge the UI");
  {
    const { ctx, page } = await newPage({
      sources: { direct: "hang", directJson3: XML },
    });
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await page.fill("input[placeholder='Paste YouTube link here...']", "https://www.youtube.com/watch?v=TEST1234567");
    await page.click("button:has-text('Load Video')");
    await page.waitForTimeout(12000);
    const enabled = await page.locator("input[placeholder='Paste YouTube link here...']").isEnabled();
    check("the URL input is re-enabled after a stalled fetch", enabled,
      "an 8s timeout bounds each source so the chain cannot hang forever");
    await ctx.close();
  }

  group("Landing and routing");
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    check("hero renders", /One link\. Every insight/.test((await page.textContent("h1")) || ""));
    await page.click("a[href='/studio']:has-text('Open studio')");
    await page.waitForURL("**/studio");
    check("navigates to the studio", page.url().endsWith("/studio"));
    check("no uncaught page errors", page.__errors.length === 0, page.__errors.join(" | "));

    await page.goto(`${BASE}/does-not-exist`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    check("an unknown route renders something", ((await page.textContent("body")) || "").trim().length > 0,
      "an unknown route must show a recovery link");
    await ctx.close();
  }

  group("URL parsing");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    const cases = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", true],
      ["https://youtu.be/dQw4w9WgXcQ", true],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", true],
      ["dQw4w9WgXcQ", true],
      ["https://vimeo.com/12345", false],
      ["not a url", false],
    ];
    const wrong = [];
    for (const [input, shouldAccept] of cases) {
      await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
      await page.fill("input[placeholder='Paste YouTube link here...']", input);
      await page.click("button:has-text('Load Video')");
      await page.waitForTimeout(400);
      const rejected = (await page.locator("text=Please enter a valid YouTube URL").count()) > 0;
      if (rejected === shouldAccept) wrong.push(input);
    }
    check("accepts every YouTube URL shape and rejects the rest", wrong.length === 0, `wrong: ${wrong.join(", ")}`);
    await ctx.close();
  }

  group("Known open findings");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    const sent = [];
    await page.route(`${BASE}/api/summary`, async (r) => {
      sent.push(JSON.parse(r.request().postData() || "{}").type);
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ response: "ok" }) });
    });
    await loadVideo(page);
    await page.click("button:has-text('Summary')");
    await page.waitForTimeout(600);
    await page.click("button:has-text('Detailed')");
    await page.waitForTimeout(600);
    check("summary sends the type that was clicked", sent[1] === "detailed",
      `clicked "Detailed", sent type="${sent[1]}"`);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({
      sources: { direct: "fail", directJson3: "fail", proxy: "fail", cors: "fail" },
    });
    await loadVideo(page);
    const badge = ((await page.locator(".badge.bg-green-50").textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    check("header badge reflects what actually loaded", !/1 language/.test(badge),
      `shows "${badge}" with zero transcripts loaded`);

    await page.click("button:has-text('Chat')");
    await page.waitForTimeout(300);
    check("chat is gated when no transcript is usable",
      (await page.locator("text=Chat requires captions").count()) > 0,
      "chat must be unavailable when caption content could not be loaded");
    await ctx.close();
  }

  group("F12 — the Download tab does not promise files it cannot deliver");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    await page.click("button:has-text('Download')");
    await page.waitForTimeout(4000);

    const links = await page.locator(".tool-column a[target='_blank']").evaluateAll((els) =>
      els.map((e) => ({ href: e.href, label: e.querySelector("p")?.textContent || "" })));

    // YouTube signs and ciphers its media URLs, so nothing here can hand the
    // user a file. Labelling a link "Video (MP4)" when it opens a homepage is
    // the bug — two links that both went to cobalt.tools/ used to claim MP4
    // and MP3.
    const fileFormatClaims = links.filter((l) => /\b(MP4|MP3|WEBM|M4A)\b/i.test(l.label));
    check("no link claims a file format it cannot produce",
      fileFormatClaims.length === 0,
      `claiming: ${JSON.stringify(fileFormatClaims.map((l) => l.label))}`);

    const hrefs = links.map((l) => l.href);
    check("no two options point at the same place",
      new Set(hrefs).size === hrefs.length, JSON.stringify(hrefs));

    check("the video link is shown so it can be pasted into the tool",
      (await page.locator("#download-video-url").inputValue()).includes("TEST1234567"),
      "the external tool needs the url, so the app must surface it");

    check("there is a copy button for it",
      (await page.locator("button:has-text('Copy')").count()) > 0);

    check("the limitation is stated plainly",
      (await page.locator("text=cannot download the file itself").count()) > 0,
      "the user should not be left wondering why no file arrived");
    await ctx.close();
  }

  group("Translate controls are usable on arrival");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);

    const btn = page.locator("button:has-text('Translate')").first();
    // The dropdown used to default to English on an English transcript, which
    // the disable rule reads as "translate to its own language" — so the
    // feature arrived permanently greyed out on most videos.
    check("the Translate button is enabled without touching anything",
      !(await btn.isDisabled()),
      `dropdown="${await page.locator("#translate-target").inputValue()}" on an English track`);

    check("the default target is not the transcript's own language",
      (await page.locator("#translate-target").inputValue()) !== "English");

    // Picking the transcript's own language should still be refused.
    await page.selectOption("#translate-target", "English");
    await page.waitForTimeout(200);
    check("choosing the transcript's own language disables it again",
      await btn.isDisabled(), "translating en -> en is a no-op and must stay blocked");
    check("and says why", !!(await btn.getAttribute("title")),
      "a greyed-out button with no explanation is the original bug");
    await ctx.close();
  }

  group("Translate controls fit a phone screen");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.route("**/*", (r) => {
      const u = r.request().url();
      if (u.startsWith(BASE) && !u.includes("/yt-timedtext")) return r.continue();
      if (u.includes("timedtext")) return r.fulfill({ status: 200, contentType: "text/xml", body: XML });
      if (u.includes("/oembed")) return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ title: "T", author_name: "A", author_url: "", thumbnail_url: "" }) });
      return r.fulfill({ status: 204, body: "" });
    });
    await page.route(`${BASE}/api/transcript`, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(META) }));
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await page.fill("input[placeholder='Paste YouTube link here...']", "dQw4w9WgXcQ");
    await page.click("button:has-text('Load Video')");
    await page.waitForSelector("button:has-text('Transcript')", { timeout: 25000 });
    await page.click("button:has-text('Transcript')");
    await page.waitForTimeout(900);

    // Measured before the fix: the button sat 10px past a 390px viewport.
    // Document scrollWidth stayed clean, so an overflow check alone missed it.
    const box = await page.locator("button:has-text('Translate')").first().boundingBox();
    check("the Translate button is fully on screen at 390px",
      !!box && box.x + box.width <= 390,
      box ? `right edge at ${Math.round(box.x + box.width)}px of 390px` : "button not found");
    await ctx.close();
  }

  group("Responsive and accessibility");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.route("**/*", (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ status: 204, body: "" })));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    check("no horizontal overflow at 390px",
      (await page.evaluate(() => document.documentElement.scrollWidth)) <= 391);
    check("every image has alt text", (await page.locator("img:not([alt])").count()) === 0);
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    check("interactive controls have accessible names",
      (await page.evaluate(() => [...document.querySelectorAll("input,select,button")]
        .filter((e) => !e.getAttribute("aria-label") && !e.textContent.trim()
          && !e.getAttribute("placeholder") && !document.querySelector(`label[for="${e.id}"]`)).length)) === 0);
    await ctx.close();
  }
  group("History, bookmarks, and browser-local persistence");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    await page.getByRole("button", { name: "History", exact: false }).first().click();
    check("a loaded video appears in history", await page.locator(".history-card").count() === 1);
    await page.getByRole("button", { name: "Save Test Video", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "History", exact: false }).first().click();
    check("history survives a page reload", await page.locator(".history-card").count() === 1);
    check("bookmarks survive a page reload", await page.getByRole("button", { name: "Unsave Test Video", exact: true }).getAttribute("aria-pressed") === "true");
    await page.getByLabel("Search history").fill("no such channel");
    check("history search filters results", await page.locator(".history-card").count() === 0);
    await page.getByLabel("Search history").fill("Test Channel");
    check("history search matches channel names", await page.locator(".history-card").count() === 1);
    await page.getByRole("button", { name: "Open Test Video", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#video-url")?.value === "TEST1234567");
    check("reopening history loads the selected video", (await page.locator("iframe").getAttribute("src")).includes("TEST1234567"));
    await page.getByRole("button", { name: "History", exact: false }).first().click();
    check("reopening does not duplicate history", await page.locator(".history-card").count() === 1);
    await fs.promises.mkdir("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/history-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "Remove Test Video", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "History", exact: false }).first().click();
    check("removing a video persists", await page.locator(".history-card").count() === 0);
    await ctx.close();
  }

  group("Transcript search, seeking, translation, and exports");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    await page.getByLabel("Search transcript").fill("consistency");
    check("transcript search keeps matching text", (await transcriptText(page)).includes("consistency") && !(await transcriptText(page)).includes("Welcome"));
    await page.getByRole("button", { name: "Seek to 1:05", exact: true }).click();
    check("timestamp seeks the persistent player", (await page.locator("iframe").getAttribute("src")).includes("start=65"));
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download text", exact: true }).click();
    const download = await downloadPromise;
    const path = await download.path();
    const exported = await fs.promises.readFile(path, "utf8");
    check("export includes the full transcript even with a search filter", exported.includes("Welcome") && exported.includes("consistency"));
    await page.route(`${BASE}/api/translate`, (route) => route.fulfill({ json: { translatedText: "مرحبا هذا نص مترجم" } }));
    await page.getByRole("button", { name: "Translate", exact: true }).click();
    await page.getByText("مرحبا هذا نص مترجم", { exact: true }).waitFor();
    check("translation response renders with automatic direction", await page.getByText("مرحبا هذا نص مترجم", { exact: true }).getAttribute("dir") === "auto");
    await page.selectOption("#translate-target", "French");
    check("changing translation language clears the previous result", await page.getByText("مرحبا هذا نص مترجم", { exact: true }).count() === 0);
    await ctx.close();
  }

  group("Chat and AI error recovery (simulated provider responses)");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    await page.route(`${BASE}/api/chat`, (route) => route.fulfill({ status: 503, json: { error: "Provider unavailable" } }));
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Question about the video").fill("What is the key point?");
    await page.getByLabel("Send message").click();
    await page.getByRole("alert").filter({ hasText: "Provider unavailable" }).waitFor();
    check("chat failure restores the question for retry", await page.getByLabel("Question about the video").inputValue() === "What is the key point?");
    await page.route(`${BASE}/api/chat`, (route) => route.fulfill({ json: { response: "At 1:05, the key point is consistency." } }));
    await page.getByLabel("Send message").click();
    await page.getByText("At 1:05, the key point is consistency.", { exact: true }).waitFor();
    check("chat response is displayed", true);
    await page.route(`${BASE}/api/summary`, (route) => route.fulfill({ status: 500, json: { error: "Summary unavailable" } }));
    await page.getByRole("button", { name: "Summary", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Summary unavailable" }).waitFor();
    check("failed summary offers a retry", await page.getByRole("button", { name: "Generate summary", exact: true }).isEnabled());
    await page.route(`${BASE}/api/summary`, (route) => route.fulfill({ json: { response: "Recovered summary" } }));
    await page.getByRole("button", { name: "Generate summary", exact: true }).click();
    await page.getByText("Recovered summary", { exact: true }).waitFor();
    check("summary recovers after retry", true);
    await page.route(`${BASE}/api/viral`, (route) => route.fulfill({ status: 500, json: { error: "Ideas unavailable" } }));
    await page.getByRole("button", { name: "Viral Shorts", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Ideas unavailable" }).waitFor();
    check("failed clip generation offers a retry", await page.getByRole("button", { name: "Generate ideas", exact: true }).isEnabled());
    await page.route(`${BASE}/api/viral`, (route) => route.fulfill({ json: { shorts: [{ title: "A useful moment", startTime: 10, endTime: 40, script: "Be consistent.", hook: "Start here", captions: ["Practice"], hashtags: ["#learning"], thumbnailSuggestion: "A notebook", reason: "Actionable", viralScore: 70 }] } }));
    await page.getByRole("button", { name: "Generate ideas", exact: true }).click();
    await page.getByText("A useful moment", { exact: true }).waitFor();
    check("clip generation renders the complete response", await page.getByText("#learning", { exact: true }).count() === 1);
    await ctx.close();
  }

  group("Slow responses cannot replace another video's results");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    let pending;
    await page.route(`${BASE}/api/summary`, (route) => { pending = route; });
    await page.getByRole("button", { name: "Summary", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Generating summary"));
    await page.fill("#video-url", "dQw4w9WgXcQ");
    await page.getByRole("button", { name: "Load Video", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("iframe")?.src.includes("dQw4w9WgXcQ"));
    await pending.fulfill({ json: { response: "STALE ANSWER FROM PREVIOUS VIDEO" } });
    await page.getByRole("button", { name: "Summary", exact: true }).click();
    await page.waitForTimeout(150);
    check("previous video response is discarded", await page.getByText("STALE ANSWER FROM PREVIOUS VIDEO", { exact: true }).count() === 0);
    await ctx.close();
  }

  group("Workspace visual checks at 1440, 768, 390, and 320px");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${BASE}/studio`);
      check(`empty studio fits at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 1440 || width === 390) await page.screenshot({ path: `docs/screenshots/studio-${width}.png`, fullPage: true });
      await loadVideo(page);
      check(`loaded studio fits at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 1440) await page.screenshot({ path: "docs/screenshots/transcript-desktop.png", fullPage: true });
    }
    check("no uncaught exceptions across responsive flows", page.__errors.length === 0, page.__errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
  prod.close();
  api.kill();
}

summarise("E2E");

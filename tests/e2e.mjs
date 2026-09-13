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

    if (url.includes("youtubei/v1/player")) {
      order.push("innertube");
      const spec = sources.innertube;
      if (!spec || spec === "fail") return route.fulfill({ status: 500, body: "" });
      if (spec === "blocked")
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }) });
      if (spec === "no-captions")
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ playabilityStatus: { status: "OK" }, captions: {} }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        playabilityStatus: { status: "OK" },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [
          { baseUrl: TRACK_URL, languageCode: "en", isTranslatable: true, name: { simpleText: "English" } },
        ] } },
      }) });
    }
    if (url.includes("/oembed")) return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ title: "Test Video", author_name: "Test Channel", author_url: "", thumbnail_url: "" }) });
    if (url.includes("/embed/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.route(`${BASE}/api/transcript`, (r) => {
    order.push("server-meta");
    const spec = sources.serverMeta;
    if (spec === "bot_check")
      return r.fulfill({ status: 429, contentType: "application/json",
        body: JSON.stringify({ error: "YouTube is challenging this server with a bot check.", code: "bot_check" }) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(META) });
  });

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
  group("Caption lookup asks the browser before the server");
  {
    // Measured against the live deployment: 12 of 12 fresh server-side lookups
    // returned bot_check, because YouTube blocks the watch page from datacenter
    // IPs. InnerTube answers cross-origin, so the viewer's own IP can be used.
    const a = await newPage({ sources: { innertube: "ok", direct: XML } });
    await loadVideo(a.page);
    check("the browser asks YouTube directly first",
      a.page.__order[0] === "innertube", `order=${JSON.stringify(a.page.__order)}`);
    check("and never touches the server endpoint when that works",
      !a.page.__order.includes("server-meta"), `order=${JSON.stringify(a.page.__order)}`);
    check("the transcript still renders",
      /Welcome to the show/.test(await transcriptText(a.page)));
    await a.ctx.close();

    // A browser that is itself challenged must not dead-end.
    const b = await newPage({ sources: { innertube: "blocked", direct: XML } });
    await loadVideo(b.page);
    check("a challenged browser falls back to the server",
      b.page.__order.includes("server-meta"), `order=${JSON.stringify(b.page.__order)}`);
    check("and the transcript still renders",
      /Welcome to the show/.test(await transcriptText(b.page)));
    await b.ctx.close();

    const c = await newPage({ sources: { innertube: "fail", direct: XML } });
    await loadVideo(c.page);
    check("a network failure also falls back",
      c.page.__order.includes("server-meta"), `order=${JSON.stringify(c.page.__order)}`);
    await c.ctx.close();
  }

  group("When both lookups fail, the server's classified error is what shows");
  {
    const { ctx, page } = await newPage({
      sources: { innertube: "blocked", serverMeta: "bot_check" },
    });
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await page.fill("input[placeholder='Paste YouTube link here...']", "https://www.youtube.com/watch?v=TEST1234567");
    await page.click("button:has-text('Load Video')");
    await page.waitForTimeout(4000);
    const err = (await page.locator("p.text-red-500").first().textContent().catch(() => "")) || "";
    check("the bot-check message reaches the user", /bot check/i.test(err), `showed: "${err.slice(0, 80)}"`);
    check("and a Try again button is offered",
      (await page.locator("button:has-text('Try again')").count()) > 0,
      "bot_check clears on its own, so retrying can work");
    await ctx.close();
  }

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
    // `order` also records the metadata lookup, so filter to the caption
    // sources this group is actually about.
    const CONTENT = ["direct", "direct-json3", "same-origin-proxy", "cors-proxy"];
    const contentOrder = page.__order.filter((s) => CONTENT.includes(s));
    check("tries the direct browser fetch first",
      contentOrder[0] === "direct",
      `content sources=${JSON.stringify(contentOrder)} — the viewer's own IP is the least throttled path`);
    check("stops as soon as a source works", contentOrder.length === 1,
      `content sources=${JSON.stringify(contentOrder)}`);
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
    const CONTENT = ["direct", "direct-json3", "same-origin-proxy", "cors-proxy"];
    check("every source was attempted",
      page.__order.filter((s) => CONTENT.includes(s)).length === 4,
      `content sources=${JSON.stringify(page.__order.filter((s) => CONTENT.includes(s)))}`);
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
    await page.click("a[href='/studio']:has-text('Try it free')");
    await page.waitForURL("**/studio");
    check("navigates to the studio", page.url().endsWith("/studio"));
    check("no uncaught page errors", page.__errors.length === 0, page.__errors.join(" | "));

    await page.goto(`${BASE}/does-not-exist`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    check("an unknown route renders something", ((await page.textContent("body")) || "").trim().length > 0,
      "no catch-all <Route> is defined, so the page is completely blank", "F17");
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
      `clicked "Detailed", sent type="${sent[1]}" — handleSummary reads state that has not committed yet`, "F05");
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({
      sources: { direct: "fail", directJson3: "fail", proxy: "fail", cors: "fail" },
    });
    await loadVideo(page);
    const badge = ((await page.locator(".badge.bg-green-50").textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    check("header badge reflects what actually loaded", !/1 language/.test(badge),
      `shows "${badge}" with zero transcripts loaded`, "F10");

    await page.click("button:has-text('Chat')");
    await page.waitForTimeout(300);
    check("chat is gated when no transcript is usable",
      (await page.locator("text=Chat requires captions").count()) > 0,
      "input is shown but Send is a silent no-op — the gate tests selectedTrack, handleChat tests transcriptText", "F11");
    await ctx.close();
  }

  group("F12 — the Download tab does not promise files it cannot deliver");
  {
    const { ctx, page } = await newPage({ sources: { direct: XML } });
    await loadVideo(page);
    await page.click("button:has-text('Download')");
    await page.waitForTimeout(4000);

    const links = await page.locator("a[target='_blank']").evaluateAll((els) =>
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
} finally {
  await browser.close();
  prod.close();
  api.kill();
}

summarise("E2E");

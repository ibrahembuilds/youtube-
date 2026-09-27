// Server-side network access to YouTube.
//
// Two separate things stop a server from reading captions. Each needs its own
// fix; both were measured against the live site on 2026-09-27.
//
//  1. IP reputation. From a datacenter IP, after roughly fifteen requests the
//     watch page answers 429, and every InnerTube client (WEB, MWEB, ANDROID,
//     IOS, TVHTML5, ANDROID_VR) answers "Sign in to confirm you're not a bot".
//     Vercel is a datacenter. No request header changes this; a rotating
//     residential proxy does. Set YOUTUBE_PROXY_URL to use one.
//
//  2. Proof-of-Origin tokens. Caption URLs now carry exp=xpe, and for those the
//     timedtext endpoint answers HTTP 200 with a zero-byte body — from any IP,
//     browsers included — unless the request carries &pot=<token>&c=WEB, where
//     the token is minted by YouTube's BotGuard and bound to the video id.
//     bgutils-js runs BotGuard inside jsdom to mint it.

const _env = typeof process !== "undefined" ? process.env : {};

// The UA BotGuard sees while minting. Caption requests send the same one so
// the token and the request describe the same client.
export const YT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36(KHTML, like Gecko)";

// ─── Proxy ────────────────────────────────────────────────────────────

let proxied = null;

export function hasYoutubeProxy() {
  return Boolean(_env.YOUTUBE_PROXY_URL);
}

/**
 * fetch() for youtube.com. Goes through YOUTUBE_PROXY_URL when it is set,
 * e.g. http://USER-rotate:PASS@p.webshare.io:80 for Webshare residential.
 * undici is imported lazily so functions that never talk to YouTube do not
 * load it.
 */
export async function youtubeFetch(url, init = {}) {
  if (!hasYoutubeProxy()) return fetch(url, init);
  if (!proxied) {
    const { ProxyAgent, fetch: undiciFetch } = await import("undici");
    proxied = { agent: new ProxyAgent(_env.YOUTUBE_PROXY_URL), fetch: undiciFetch };
  }
  return proxied.fetch(url, { ...init, dispatcher: proxied.agent });
}

// ─── PO token minting ─────────────────────────────────────────────────

// Fixed key YouTube's web player uses for the WAA GenerateIT call.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const MINT_TIMEOUT_MS = 15000;

let minterPromise = null;
let minterExpires = 0;

/**
 * The BotGuard interpreter is remote JavaScript that runs inside this
 * process, so only accept it from the one place YouTube serves it.
 */
export function interpreterUrlFrom(wrapped) {
  if (typeof wrapped !== "string") return null;
  let url;
  try {
    url = new URL(wrapped.startsWith("//") ? `https:${wrapped}` : wrapped);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.google.com") return null;
  if (!url.pathname.startsWith("/js/th/")) return null;
  return url.href;
}

async function createMinter() {
  const [{ JSDOM, VirtualConsole }, { BotGuardClient }, { WebPoMinter }, { buildURL, getHeaders, parseLooseJSON }] =
    await Promise.all([
      import("jsdom"),
      import("bgutils-js/botguard"),
      import("bgutils-js/webpo"),
      import("bgutils-js/utils"),
    ]);

  const pageRes = await youtubeFetch("https://www.youtube.com/", {
    headers: { accept: "*/*", "accept-language": "en-US,en;q=0.7", "user-agent": YT_USER_AGENT },
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!pageRes.ok) throw new Error(`YouTube homepage returned HTTP ${pageRes.status}`);
  const pageHtml = await pageRes.text();

  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
  if (!ytConfig || !attestation) throw new Error("BotGuard challenge not found on the YouTube homepage");

  const challenge = parseLooseJSON(attestation)?.R?.bgChallenge;
  const interpreterUrl = interpreterUrlFrom(
    challenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue
  );
  if (!challenge?.program || !challenge?.globalName || !interpreterUrl) {
    throw new Error("BotGuard challenge was incomplete or pointed somewhere unexpected");
  }

  // BotGuard reads browser globals. An empty VirtualConsole keeps jsdom's
  // "not implemented: canvas" notices out of the function logs.
  const dom = new JSDOM("<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>", {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    userAgent: YT_USER_AGENT,
    virtualConsole: new VirtualConsole(),
  });
  dom.window.yt = { config_: JSON.parse(ytConfig) };
  Object.assign(globalThis, {
    yt: dom.window.yt,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!("navigator" in globalThis)) {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  }

  const interpreterRes = await fetch(interpreterUrl, { signal: AbortSignal.timeout(MINT_TIMEOUT_MS) });
  if (!interpreterRes.ok) throw new Error(`BotGuard interpreter returned HTTP ${interpreterRes.status}`);
  new Function(await interpreterRes.text())();

  const botguard = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput = [];
  const snapshot = await botguard.snapshot({ webPoSignalOutput });

  const itRes = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, snapshot]),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!itRes.ok) throw new Error(`GenerateIT returned HTTP ${itRes.status}`);
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itRes.json();
  if (!integrityToken) throw new Error("GenerateIT returned no integrity token");

  const minter = await WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput
  );

  // Measured TTL is 43200s. Renew five minutes early so a warm instance never
  // mints from an integrity token that expires mid-request.
  const ttl = Number(estimatedTtlSecs) > 600 ? Number(estimatedTtlSecs) : 3600;
  minterExpires = Date.now() + (ttl - 300) * 1000;
  return minter;
}

/**
 * A PO token bound to one video, for its caption requests. The minter is
 * built once per warm instance (about half a second) and reused until its
 * integrity token nears expiry; each mint after that is local.
 */
export async function mintCaptionToken(videoId) {
  if (!minterPromise || Date.now() >= minterExpires) {
    minterExpires = Number.POSITIVE_INFINITY; // until createMinter sets the real value
    minterPromise = createMinter();
  }
  try {
    const minter = await minterPromise;
    return await minter.mintAsWebsafeString(videoId);
  } catch (err) {
    // Never cache a failure — the next request builds a fresh minter.
    minterPromise = null;
    minterExpires = 0;
    throw err;
  }
}

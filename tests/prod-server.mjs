// Serves dist/ using the rewrite rules from the project's REAL vercel.json.
// Tests run against this rather than the Vite dev server, because the routing
// difference between the two is exactly where production bugs hide: Vite has a
// /yt-timedtext proxy that Vercel only has if vercel.json says so.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon",
};

function loadRewrites() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")).rewrites || [];
}

/** Resolve a pathname through the rewrite list, first match wins (Vercel's rule). */
export function resolveRewrite(pathname, rewrites = loadRewrites()) {
  for (const rule of rewrites) {
    const re = new RegExp(`^${rule.source}$`);
    const m = pathname.match(re);
    if (!m) continue;
    const destination = rule.destination.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? "");
    return { destination, external: /^https?:\/\//.test(destination) };
  }
  return { destination: pathname, external: false };
}

export function startProdServer({ port = 4173, apiPort = 3001 } = {}) {
  const rewrites = loadRewrites();

  const serveFile = (res, file) => {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  };
  const distFile = (pathname) => {
    const file = path.join(DIST, pathname);
    return file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  };

  const server = http.createServer((req, res) => {
    const { pathname, search } = new URL(req.url, "http://local");

    // Vercel checks the filesystem before applying rewrites, so a real asset
    // is served as itself and never falls into the SPA catch-all.
    const asset = pathname === "/" ? null : distFile(pathname);
    if (asset) return serveFile(res, asset);

    const hit = resolveRewrite(pathname, rewrites);

    // Surfaced so tests can assert on the ROUTING DECISION without depending
    // on whatever the upstream happens to return that day.
    res.setHeader("x-rewrite-target", hit.destination);
    res.setHeader("x-rewrite-external", String(hit.external));

    if (hit.external) {
      res.writeHead(204).end();
      return;
    }

    if (hit.destination.startsWith("/api/")) {
      const proxy = http.request(
        { host: "localhost", port: apiPort, path: hit.destination + search, method: req.method, headers: req.headers },
        (upstream) => {
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(res);
        }
      );
      proxy.on("error", () => res.writeHead(502).end('{"error":"api unreachable"}'));
      req.pipe(proxy);
      return;
    }

    const rewritten = distFile(hit.destination);
    if (rewritten) return serveFile(res, rewritten);

    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(path.join(DIST, "index.html")).pipe(res);
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

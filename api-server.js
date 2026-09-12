// Local dev server that mounts the Vercel serverless functions from /api
// so `npm run dev` works end-to-end without deploying to Vercel first.
// Vite proxies /api/* to this server (see vite.config.ts).
import express from "express";

try {
  process.loadEnvFile(); // reads .env — Vercel does this automatically in production
} catch {
  // no .env file — fine if OPENROUTER_API_KEY is set some other way
}

// Vite serves the app on :3000 and proxies /api to this server on :3001, so a
// browser request arrives with Origin localhost:3000 but Host localhost:3001.
// That is not same-origin, and the API's CORS check would reject it. Allow the
// dev origin explicitly. This file only ever runs in development — in
// production the functions in api/ run on Vercel and this never executes.
const DEV_ORIGIN = `http://localhost:${process.env.PORT || 3000}`;
process.env.ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGINS, DEV_ORIGIN]
  .filter(Boolean)
  .join(",");

const app = express();

// The handlers read the raw request stream themselves, so no body parser here.
const routes = ["transcript", "translate", "chat", "summary", "viral", "download"];

for (const route of routes) {
  const { default: handler } = await import(`./api/${route}.js`);
  app.all(`/api/${route}`, (req, res) => handler(req, res));
}

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API dev server running on http://localhost:${PORT}`);
  console.log(`CORS allow-list: ${process.env.ALLOWED_ORIGINS}`);
});

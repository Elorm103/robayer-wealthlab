// Local dev-only static file server + API proxy. Not part of the
// deployed product (GitHub Pages serves the real static site; the
// Worker is the real API) — this exists solely so a local browser can
// exercise the admin UI against a real `wrangler dev` instance under
// one origin, mirroring production's same-origin architecture
// (docs/v2-same-origin-architecture.md). Without this, a relative
// fetch('/api/...') from a page served by a plain static server
// resolves to that same static server (404), never reaching the
// Worker on its own port — a real gap found while verifying Phase 3
// Stage 3 (Orders) locally.
//
// Usage: node scripts/dev-proxy.mjs [staticPort] [apiPort]
// Defaults: staticPort=5500, apiPort=8787. Wired into .claude/launch.json's
// "robayer-static-site" configuration.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_PORT = Number(process.argv[2] || process.env.PORT || 5500);
const API_PORT = Number(process.argv[3] || 8787);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function proxyToApi(req, res) {
  const target = http.request(
    {
      hostname: 'localhost',
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${API_PORT}` },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode || 502, apiRes.headers);
      apiRes.pipe(res);
    }
  );
  target.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: `Could not reach wrangler dev on :${API_PORT} (${err.code || err.message}). Is it running?` } }));
  });
  req.pipe(target);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath);

  if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  if (!path.extname(filePath) && !fs.existsSync(filePath)) filePath = `${filePath}.html`;

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// `/books/*` is entirely Worker-owned in production too (backend/routes/books.ts's
// own header comment — no origin fetch, rendered straight from D1) — proxying it
// here as well as `/api/*` closes a real local-dev gap found during Version 3.0
// Founder Edition Step 2 verification: without this, this proxy silently served
// a stale static HTML file left over from before the Products migration instead
// of the real server-rendered page, making an admin edit look like it hadn't
// taken effect when it actually had.
const WORKER_OWNED_PREFIXES = ['/api/', '/books/'];

const server = http.createServer((req, res) => {
  if (WORKER_OWNED_PREFIXES.some((prefix) => req.url.startsWith(prefix))) {
    proxyToApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(STATIC_PORT, () => {
  console.log(`Dev proxy: http://localhost:${STATIC_PORT} (static) -> /api/* proxied to http://localhost:${API_PORT}`);
});

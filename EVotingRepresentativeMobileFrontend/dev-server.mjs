/*
 * Local stand-in for Cloudflare, for trying the page on your own computer against a running API (no Cloudflare account needed):
 *
 *   KIOSK_SECRET=<the API's EVOTING_KIOSK_SECRET> API_BASE=http://localhost:5000 node dev-server.mjs
 *   then open http://localhost:8787
 *
 * It runs the REAL worker.js (the same file Cloudflare runs) and serves ./public with the rules of public/_headers.
 * It is for local checks only; production is deployed with `npx wrangler deploy` (see README.md).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
};

/** The rules of public/_headers (the same file Cloudflare reads): a path pattern, then indented "Name: value" lines. */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { current = { pattern: raw.trim(), headers: [] }; rules.push(current); continue; }
    const i = raw.indexOf(':');
    if (current && i > 0) current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
  }
  return rules;
}

const patternToRegExp = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export async function makeAssets() {
  let rules = [];
  try { rules = parseHeadersFile(await readFile(join(PUBLIC, '_headers'), 'utf8')).map(r => ({ ...r, re: patternToRegExp(r.pattern) })); } catch { /* no rules */ }
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = resolve(PUBLIC, '.' + normalize('/' + rel));
      if (!file.startsWith(PUBLIC + sep) || /(^|[\\/])_headers$/.test(file)) return new Response('Not found', { status: 404 });
      let body;
      try { body = await readFile(file); } catch { return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }); }
      const headers = new Headers({ 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
      for (const r of rules) if (r.re.test(url.pathname)) for (const [k, v] of r.headers) headers.set(k, v);
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    },
  };
}

export async function startServer({ port = 0, env = {}, host = '127.0.0.1' } = {}) {
  const worker = (await import(pathToFileURL(join(ROOT, 'worker.js')).href + '?dev=' + Date.now())).default;
  const workerEnv = { ...env, ASSETS: await makeAssets() };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const response = await worker.fetch(request, workerEnv);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('dev server error: ' + (e && e.message));
    }
  });
  await new Promise(ok => server.listen(port, host, ok));
  return { server, port: server.address().port, close: () => new Promise(ok => server.close(ok)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { KIOSK_SECRET, KIOSK_ID, API_BASE, CACHE_SECONDS, PORT } = process.env;
  if (!KIOSK_SECRET) console.warn('KIOSK_SECRET is not set: the API will refuse the kiosk sign-in and nobody can be verified.');
  const { port } = await startServer({ port: Number(PORT) || 8787, env: { KIOSK_SECRET, KIOSK_ID, API_BASE, CACHE_SECONDS } });
  console.log(`Representative voting page: http://localhost:${port}   (API: ${API_BASE || 'https://api.eballotsacdeco.site'})`);
}

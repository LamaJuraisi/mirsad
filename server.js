import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStories, collect } from './lib/aggregate.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 300) * 1000;
// A manual refresh can bypass the cache, but never hit the outlets more often than this.
const MIN_REFETCH_MS = Number(process.env.MIN_REFETCH_SECONDS || 60) * 1000;
const FEEDS_FILE = process.env.FEEDS_FILE || join(ROOT, 'feeds.json');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

let cache = null;
let inflight = null;

async function loadOutlets() {
  const config = JSON.parse(await readFile(FEEDS_FILE, 'utf8'));
  return config.outlets.filter((outlet) => outlet.feeds?.length);
}

async function refresh() {
  if (!inflight) {
    inflight = (async () => {
      const startedAt = Date.now();
      const { items, sources } = await collect(await loadOutlets());
      const stories = buildStories(items);
      const failed = sources.filter((source) => !source.ok);
      console.log(`[mirsad] ${stories.length} stories from ${sources.length - failed.length}/${sources.length} feeds in ${Date.now() - startedAt}ms`);
      failed.forEach((source) => console.warn(`[mirsad]   ✗ ${source.countryKey}/${source.outletKey} ${source.url} — ${source.error}`));
      cache = { generatedAt: Date.now(), stories, sources };
      return cache;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

async function getStories(force) {
  const age = cache ? Date.now() - cache.generatedAt : Infinity;
  if (!cache || age > CACHE_TTL_MS || (force && age > MIN_REFETCH_MS)) return refresh();
  return cache;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  res.end(body);
}

async function serveStatic(pathname, res) {
  const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
  if (relative.startsWith('..')) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(join(PUBLIC_DIR, relative));
    send(res, 200, body, { 'content-type': TYPES[extname(relative)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');

  if (url.pathname === '/api/stories') {
    try {
      const data = await getStories(url.searchParams.get('refresh') === '1');
      return send(res, 200, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    } catch (error) {
      console.error('[mirsad] refresh failed', error);
      return send(res, 502, JSON.stringify({ error: 'feeds_unavailable' }), { 'content-type': 'application/json; charset=utf-8' });
    }
  }
  if (url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, generatedAt: cache?.generatedAt ?? null, sources: cache?.sources ?? [] }), { 'content-type': 'application/json; charset=utf-8' });
  }
  return serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`[mirsad] http://localhost:${PORT}`);
  refresh().catch((error) => console.error('[mirsad] initial fetch failed', error));
});

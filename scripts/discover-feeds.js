// Finds working feed URLs for outlets whose configured feed fails: reads the site's homepage for
// the feed it advertises (<link rel="alternate" type="application/rss+xml">), then tries common
// feed paths. Prints one line per outlet. Run where the sites are reachable (GitHub Actions).
import { readFile } from 'node:fs/promises';
import { fetchFeed, USER_AGENT } from '../lib/aggregate.js';

const PATHS = ['/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/ar/feed', '/ar/rss', '/arabic/rss.xml', '/rss/latest', '/feeds/rss'];

const config = JSON.parse(await readFile(new URL('../feeds.json', import.meta.url), 'utf8'));
const only = process.argv.slice(2);

async function works(url) {
  try {
    const items = await fetchFeed(url, { timeoutMs: 15000 });
    return items.length ? `${items.length} items · latest: ${items[0].title.slice(0, 70)}` : 0;
  } catch {
    return 0;
  }
}

async function advertised(origin) {
  try {
    const response = await fetch(origin, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { status: response.status, links: [] };
    const html = await response.text();
    const links = [...html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)]
      .map((match) => /href=["']([^"']+)["']/i.exec(match[0])?.[1])
      .filter(Boolean)
      .map((href) => new URL(href, origin).href);
    return { status: response.status, links: [...new Set(links)] };
  } catch (error) {
    return { status: error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code || error.message), links: [] };
  }
}

for (const outlet of config.outlets) {
  const id = `${outlet.countryKey}/${outlet.outletKey}`;
  if (only.length && !only.includes(id)) continue;
  const current = outlet.feeds[0];
  const count = await works(current);
  if (count) {
    console.log(`OK    ${id} ${current} (${count})`);
    continue;
  }
  const origin = new URL(current).origin + '/';
  const home = await advertised(origin);
  const candidates = [...home.links, ...PATHS.map((path) => new URL(path, origin).href)].filter((url) => url !== current);
  let found = null;
  for (const url of [...new Set(candidates)]) {
    const n = await works(url);
    if (n) { found = `${url} (${n})`; break; }
  }
  console.log(found ? `FOUND ${id} ${found}` : `NONE  ${id} homepage ${home.status}; advertised: ${home.links.join(' ') || '-'}`);
}

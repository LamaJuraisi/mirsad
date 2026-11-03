// Fetches every feed in feeds.json once and reports which ones work.
import { readFile } from 'node:fs/promises';
import { fetchFeed } from '../lib/aggregate.js';

const config = JSON.parse(await readFile(new URL('../feeds.json', import.meta.url), 'utf8'));
const jobs = config.outlets.flatMap((outlet) => (outlet.feeds || []).map((url) => ({ outlet, url })));

let failures = 0;
await Promise.all(jobs.map(async ({ outlet, url }) => {
  const label = `${outlet.countryKey}/${outlet.outletKey}`.padEnd(28);
  try {
    const items = await fetchFeed(url);
    const newest = Math.max(...items.map((item) => item.publishedAt || 0));
    const age = newest ? `${Math.round((Date.now() - newest) / 60000)}m ago` : 'undated';
    console.log(`✓ ${label} ${String(items.length).padStart(3)} items, newest ${age}  ${items[0]?.title.slice(0, 50) || ''}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${label} ${url} — ${error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code || error.message)}`);
  }
}));

console.log(`\n${jobs.length - failures}/${jobs.length} feeds OK`);
process.exitCode = failures === jobs.length ? 1 : 0;

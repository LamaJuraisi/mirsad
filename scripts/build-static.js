// Builds the server-less website: dist/index.html reads dist/stories.json, which this script
// fetches now. Run on a schedule (see .github/workflows/publish.yml) to keep the site fresh.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStories, collect } from '../lib/aggregate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.env.OUT_DIR || join(ROOT, 'dist');
const FEEDS_FILE = process.env.FEEDS_FILE || join(ROOT, 'feeds.json');

const config = JSON.parse(await readFile(FEEDS_FILE, 'utf8'));
const outlets = config.outlets.filter((outlet) => outlet.feeds?.length);
const startedAt = Date.now();
const { items, sources } = await collect(outlets);
const stories = buildStories(items);
const ok = sources.filter((source) => source.ok);

const lines = sources
  .slice()
  .sort((a, b) => Number(b.ok) - Number(a.ok) || a.countryKey.localeCompare(b.countryKey))
  .map((source) => `| ${source.ok ? '✓' : '✗'} | ${source.countryKey}/${source.outletKey} | ${source.ok ? source.count : source.error} | ${source.url} |`);
const report = [
  `## Mirsad build: ${stories.length} stories from ${ok.length}/${sources.length} feeds (${Date.now() - startedAt} ms)`,
  '',
  '| | Outlet | Items / error | Feed |',
  '|---|---|---|---|',
  ...lines,
  ''
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);

if (!ok.length) {
  // Keep the last good deployment live rather than publishing an empty site.
  console.error('No feed could be fetched; not publishing.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'stories.json'), JSON.stringify({ generatedAt: Date.now(), stories, sources }));
const page = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
const marker = page.lastIndexOf('  <script>');
const setting = '  <script>window.MIRSAD_STORIES_URL = "stories.json";</script>\n';
await writeFile(join(OUT, 'index.html'), page.slice(0, marker) + setting + page.slice(marker));
console.log(`Wrote ${OUT}`);

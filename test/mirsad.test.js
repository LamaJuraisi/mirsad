import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBody, parseFeed, cleanText } from '../lib/parse.js';
import { cluster, findHedge, splitUrgent, tokens } from '../lib/corroborate.js';
import { buildStories, collect } from '../lib/aggregate.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const OUTLETS = (base) => [
  { countryKey: 'lebanon', outletKey: 'annahar', name: 'النهار', language: 'العربية', feeds: [`${base}/outlet-a.xml`] },
  { countryKey: 'lebanon', outletKey: 'alakhbar', name: 'الأخبار', language: 'العربية', feeds: [`${base}/outlet-b.atom`] },
  { countryKey: 'egypt', outletKey: 'mada-masr', name: 'مدى مصر', language: 'العربية', feeds: [`${base}/outlet-c-1256.xml`, `${base}/missing.xml`] }
];

let fixtureServer;
let base;

before(async () => {
  fixtureServer = createServer(async (req, res) => {
    try {
      const now = new Date();
      const raw = await readFile(new URL(req.url.slice(1), FIXTURES));
      // Placeholders are ASCII, so substituting on latin1 keeps non-UTF-8 bytes intact.
      const body = raw.toString('latin1').replaceAll('{{NOW_RFC}}', now.toUTCString()).replaceAll('{{NOW_ISO}}', now.toISOString());
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(Buffer.from(body, 'latin1'));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => fixtureServer.listen(0, resolve));
  base = `http://127.0.0.1:${fixtureServer.address().port}`;
});

after(() => fixtureServer.close());

test('cleanText strips markup, entities and WordPress footers', () => {
  assert.equal(cleanText('<p>نص &amp;amp; آخر</p><p>The post X appeared first on Y.</p>'), 'نص & آخر');
  assert.ok(cleanText('ك'.repeat(10) + ' ' + 'ب'.repeat(400), 50).endsWith('…'));
});

test('decodeBody honours windows-1256', async () => {
  const raw = await readFile(new URL('outlet-c-1256.xml', FIXTURES));
  const items = parseFeed(decodeBody(raw));
  assert.equal(items[0].title, 'مهرجان الموسيقى يبدأ غداً');
});

test('parseFeed reads Atom alternate links', async () => {
  const xml = (await readFile(new URL('outlet-b.atom', FIXTURES), 'utf8')).replaceAll('{{NOW_ISO}}', new Date().toISOString());
  const items = parseFeed(xml);
  assert.equal(items[0].link, 'https://b.example/power-plan');
  assert.equal(items.length, 2);
});

test('urgent prefix and hedging detection', () => {
  assert.deepEqual(splitUrgent('عاجل | خبر'), { urgent: true, title: 'خبر' });
  assert.equal(findHedge('أنباء عن إغلاق طريق'), 'أنباء عن');
  assert.equal(findHedge('ارتفاع تداول أسهم الطاقة'), null);
  assert.ok(tokens('والكهرباء اللبنانية').has('كهرباء'));
});

test('cluster merges the same event but not look-alike headlines', () => {
  const now = Date.now();
  const items = [
    ['a', 'وزير الخارجية المصري يلتقي نظيره الأردني في القاهرة'],
    ['b', 'وزير الخارجية المصري يبحث مع نظيره السعودي ملف السودان'],
    ['c', 'الرئيس المصري يستقبل وزير الخارجية الأمريكي في القاهرة'],
    ['d', 'لقاء بين وزيري خارجية مصر والأردن في القاهرة لبحث التطورات'],
    ['e', 'قصف إسرائيلي يستهدف مدرسة في غزة'],
    ['f', 'قصف إسرائيلي على خان يونس يوقع قتلى في غزة']
  ].map(([outletId, title], index) => ({ outletId, title, publishedAt: now + index, link: String(index) }));
  const groups = cluster(items).map((group) => group.map((item) => item.outletId).sort().join('+')).sort();
  assert.deepEqual(groups, ['a+d', 'b', 'c', 'e', 'f']);
});

test('collect + buildStories corroborates across outlets and reports failures', async () => {
  const { items, sources } = await collect(OUTLETS(base));
  assert.equal(sources.filter((source) => !source.ok).length, 1, 'missing feed is reported, not thrown');
  assert.ok(!items.some((item) => item.link.endsWith('/old')), 'stale items are dropped');

  const stories = buildStories(items);
  const power = stories.find((story) => story.headline.includes('الكهرباء'));
  assert.equal(power.reliability, 'confirmed');
  assert.equal(power.urgent, true);
  assert.deepEqual(power.coverage.sort(), ['lebanon|alakhbar', 'lebanon|annahar']);
  assert.equal(power.updates.length, 1);
  assert.match(power.why[0], /مصدران مستقلان/);

  assert.equal(stories.find((story) => story.url.endsWith('/road')).reliability, 'unverified');
  assert.equal(stories.find((story) => story.url.endsWith('/stocks')).reliability, 'likely');
  assert.equal(stories.find((story) => story.url.endsWith('/music')).countryKey, 'egypt');
  assert.equal(new Set(stories.map((story) => story.id)).size, stories.length);
});

test('server serves the app and /api/stories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirsad-'));
  const feedsFile = join(dir, 'feeds.json');
  await writeFile(feedsFile, JSON.stringify({ outlets: OUTLETS(base) }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), FEEDS_FILE: feedsFile },
    stdio: 'pipe'
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => String(chunk).includes('http://localhost') && resolve());
      child.on('exit', reject);
    });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await page.text(), /مِرصد/);
    const data = await (await fetch(`http://127.0.0.1:${port}/api/stories`)).json();
    assert.ok(data.stories.length >= 4);
    assert.ok(data.sources.length === 4);
    assert.equal((await fetch(`http://127.0.0.1:${port}/../server.js`)).status, 404);
  } finally {
    child.kill();
  }
});

test('build-static writes the page and stories.json, and refuses when no feed works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirsad-static-'));
  const run = (feeds, out) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build-static.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, FEEDS_FILE: feeds, OUT_DIR: out, GITHUB_STEP_SUMMARY: '' },
      stdio: 'ignore'
    });
    child.on('exit', resolve);
  });

  const good = join(dir, 'good.json');
  await writeFile(good, JSON.stringify({ outlets: OUTLETS(base) }));
  assert.equal(await run(good, join(dir, 'out')), 0);
  const data = JSON.parse(await readFile(join(dir, 'out', 'stories.json'), 'utf8'));
  assert.ok(data.stories.length >= 4);
  assert.match(await readFile(join(dir, 'out', 'index.html'), 'utf8'), /MIRSAD_STORIES_URL = "stories.json"/);

  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ outlets: [{ countryKey: 'egypt', outletKey: 'x', name: 'x', feeds: [`${base}/missing.xml`] }] }));
  assert.equal(await run(bad, join(dir, 'out-bad')), 1);
});

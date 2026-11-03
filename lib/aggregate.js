import { createHash } from 'node:crypto';
import { decodeBody, parseFeed } from './parse.js';
import { assess, cluster, splitUrgent } from './corroborate.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; MirsadBot/0.1; +https://example.invalid/mirsad)';
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_ITEMS_PER_FEED = 40;

const shortHash = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);

export async function fetchFeed(url, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = decodeBody(await response.arrayBuffer(), response.headers.get('content-type') || '');
  return parseFeed(body);
}

async function mapLimit(list, limit, task) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await task(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetches every configured feed. Never throws; failures are reported per source. */
export async function collect(outlets, options = {}) {
  const jobs = outlets.flatMap((outlet) => (outlet.feeds || []).map((url) => ({ outlet, url })));
  const now = options.now ?? Date.now();
  const results = await mapLimit(jobs, options.concurrency ?? 8, async ({ outlet, url }) => {
    try {
      const items = await fetchFeed(url, options);
      return { outlet, url, ok: true, items };
    } catch (error) {
      return { outlet, url, ok: false, error: error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code || error.message) };
    }
  });

  const seen = new Set();
  const items = [];
  for (const result of results) {
    if (!result.ok) continue;
    const { outlet } = result;
    for (const item of result.items.slice(0, MAX_ITEMS_PER_FEED)) {
      // Undated items are treated as "just fetched" so they still appear; future dates are clamped.
      const publishedAt = Math.min(item.publishedAt ?? now, now);
      if (now - publishedAt > MAX_AGE_MS || seen.has(item.link)) continue;
      seen.add(item.link);
      const { urgent, title } = splitUrgent(item.title);
      items.push({ ...item, title, urgent, publishedAt, outlet, outletId: `${outlet.countryKey}|${outlet.outletKey}` });
    }
  }

  const sources = results.map(({ outlet, url, ok, items: list, error }) => ({
    countryKey: outlet.countryKey, outletKey: outlet.outletKey, url, ok, count: ok ? list.length : 0, ...(ok ? {} : { error })
  }));
  return { items, sources };
}

/** Turns clustered feed items into the story objects the app renders. */
export function buildStories(items) {
  const names = new Map(items.map((item) => [item.outletId, item.outlet.name]));
  const stories = cluster(items).map((group) => {
    group.sort((a, b) => a.publishedAt - b.publishedAt);
    const lead = group[0];
    const { reliability, why } = assess(group, (id) => names.get(id) || id);
    const others = group.slice(1).filter((item) => item.outletId !== lead.outletId);
    return {
      id: shortHash(lead.link),
      countryKey: lead.outlet.countryKey,
      outletKey: lead.outlet.outletKey,
      sourceType: 'local',
      originalLanguage: lead.outlet.language || 'العربية',
      translated: false,
      reliability,
      urgent: group.some((item) => item.urgent),
      headline: lead.title,
      summary: lead.summary || group.find((item) => item.summary)?.summary || '',
      context: lead.categories.length ? `مصنفة في ${lead.outlet.name} ضمن: ${lead.categories.slice(0, 3).join('، ')}.` : '',
      why,
      url: lead.link,
      publishedAt: lead.publishedAt,
      updatedAt: group[group.length - 1].publishedAt,
      updates: others.map((item) => ({ at: item.publishedAt, text: `غطّتها ${item.outlet.name}: ${item.title}`, url: item.link })),
      coverage: [...new Set(group.map((item) => item.outletId))]
    };
  });
  return stories.sort((a, b) => b.updatedAt - a.updatedAt);
}

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // Keep everything as strings; titles like "218" must not become numbers.
  parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name)
});

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', laquo: '«', raquo: '»', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

// Many Arabic sites still serve windows-1256; honour the declared charset instead of assuming UTF-8.
export function decodeBody(buffer, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] || /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  try {
    return new TextDecoder(declared.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function text(node) {
  if (node == null) return '';
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return String(node);
}

export function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function cleanText(html, maxLength = 0) {
  let value = decodeEntities(String(html || ''))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  value = decodeEntities(value)
    // WordPress footers and "read more" stubs.
    .replace(/The post .+ appeared first on .+\.?$/i, '')
    .replace(/ظهرت المقالة .+ أولاً على .+$/, '')
    .replace(/\[(…|\.\.\.|&hellip;)\]/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLength && value.length > maxLength) {
    const cut = value.slice(0, maxLength);
    value = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), maxLength * 0.7))}…`;
  }
  return value;
}

function atomLink(links) {
  const list = Array.isArray(links) ? links : [links];
  const alternate = list.find((link) => link && typeof link === 'object' && (!link['@rel'] || link['@rel'] === 'alternate'));
  return (alternate && alternate['@href']) || text(list[0]);
}

function parseDate(value) {
  const time = Date.parse(text(value));
  return Number.isFinite(time) ? time : null;
}

/**
 * Parses an RSS 2.0, RSS 1.0 (RDF) or Atom document into plain items.
 * Returns [{ title, link, summary, publishedAt, categories }].
 */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc.rss?.channel || doc['rdf:RDF'];
  const raw = channel ? (channel.item || doc['rdf:RDF']?.item || []) : (doc.feed?.entry || []);
  if (!channel && !doc.feed) throw new Error('Not an RSS or Atom document');
  const isAtom = !channel;

  return raw.map((entry) => {
    const link = isAtom ? atomLink(entry.link) : text(entry.link) || text(entry.guid);
    const summarySource = isAtom
      ? text(entry.summary) || text(entry.content)
      : text(entry.description) || text(entry['content:encoded']);
    return {
      title: cleanText(text(entry.title)),
      link: link.trim(),
      summary: cleanText(summarySource, 320),
      publishedAt: parseDate(isAtom ? (entry.published || entry.updated) : (entry.pubDate || entry['dc:date'])),
      categories: (entry.category || []).map((category) => cleanText(typeof category === 'object' ? (category['@term'] || text(category)) : category)).filter(Boolean)
    };
  }).filter((item) => item.title && item.link);
}

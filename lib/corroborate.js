// Groups items from different outlets that report the same story, then derives a
// reliability level from how many independent outlets carry it. This is a
// mechanical signal (headline overlap), not editorial fact-checking.

const STOPWORDS = new Set([
  'في', 'من', 'علي', 'الي', 'عن', 'مع', 'بعد', 'قبل', 'خلال', 'حول', 'ضد', 'بين', 'منذ', 'حتي', 'لدي', 'عند',
  'ان', 'او', 'ثم', 'لم', 'لن', 'قد', 'لا', 'ما', 'ماذا', 'كيف', 'هل', 'كل', 'غير', 'دون', 'اي',
  'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'هو', 'هي', 'هم', 'كان', 'كانت', 'يكون', 'تكون',
  // Roles and reporting verbs: present in most political headlines, so they say nothing about which story it is.
  'رييس', 'وزير', 'وزيره', 'وزيري', 'وزراء', 'نظيره', 'نظيرها', 'نظيريه', 'خارجيه', 'حكومه', 'مسوول', 'مسوولين', 'مصادر', 'مصدر',
  'يلتقي', 'يبحث', 'بحث', 'لبحث', 'يستقبل', 'لقاء', 'يعلن', 'تعلن', 'اعلن', 'اعلنت', 'قال', 'قالت', 'يقول', 'اكد', 'اكدت', 'يوكد', 'توكد',
  'عاجل', 'فيديو', 'صور', 'بالصور', 'بالفيديو', 'شاهد', 'مباشر', 'جديد', 'جديده', 'اليوم', 'امس',
  'the', 'a', 'an', 'says', 'said', 'minister', 'president', 'official', 'officials', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'after', 'says',
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'en', 'au', 'aux', 'pour', 'sur', 'par'
]);

// Phrases outlets use when they are passing on something they have not confirmed.
// Display spelling; matched after normalization. Avoids bare "تداول", which is
// also stock trading (and the Saudi exchange's name).
const HEDGES = ['أنباء عن', 'أنباء حول', 'أنباء متداولة', 'مقاطع متداولة', 'تداول ناشطون', 'رواد مواقع التواصل', 'غير مؤكدة', 'غير مؤكد', 'شائعات', 'إشاعات', 'مزاعم', 'يزعم', 'reportedly', 'unconfirmed', 'rumor', 'rumour'];

const URGENT = /^\s*(عاجل|عاجـل|breaking)\s*[|:\-–—]+\s*/i;

const WINDOW_MS = 48 * 60 * 60 * 1000;
const MIN_SHARED = 3;
const MIN_SIMILARITY = 0.4;

export function normalizeArabic(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

function stem(token) {
  // The definite article is unambiguous enough to always strip: "والحكومة" -> "حكومه".
  for (const prefix of ['وال', 'بال', 'كال', 'فال', 'لل', 'ال']) {
    if (token.startsWith(prefix) && token.length - prefix.length >= 3) return token.slice(prefix.length);
  }
  return token;
}

// Single-letter prefixes (و ب ل ف ك) and nisba endings are ambiguous ("وزارة" is not
// "و" + "زارة"), so instead of stripping them we also accept the shorter form as a match.
function variants(token) {
  const forms = [token];
  if (/^[وبلفك]/.test(token) && token.length >= 5) forms.push(token.slice(1));
  for (const form of [...forms]) {
    const bare = form.replace(/(يون|يين|يه|ي)$/, '');
    if (bare !== form && bare.length >= 3) forms.push(bare);
  }
  return forms;
}

export function tokens(value) {
  const words = normalizeArabic(value).split(/[^\p{L}\p{N}]+/u);
  const result = new Set();
  for (const word of words) {
    if (!word || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (stemmed.length >= 3 && !STOPWORDS.has(stemmed)) result.add(stemmed);
  }
  return result;
}

function bag(value) {
  const words = tokens(value);
  const forms = new Set();
  for (const word of words) variants(word).forEach((form) => forms.add(form));
  return { words, forms };
}

// Rarer words count for more: "غزة" in two headlines means little on a busy day, "خان يونس" means more.
function similarity(a, b, weight) {
  let shared = 0;
  let sharedWeight = 0;
  for (const word of a.words) {
    if (variants(word).some((form) => b.forms.has(form))) {
      shared += 1;
      sharedWeight += weight(word);
    }
  }
  if (shared < MIN_SHARED) return 0;
  let total = -sharedWeight;
  for (const word of a.words) total += weight(word);
  for (const word of b.words) total += weight(word);
  return sharedWeight / total;
}

export function splitUrgent(title) {
  const urgent = URGENT.test(title);
  return { urgent, title: urgent ? title.replace(URGENT, '').trim() : title };
}

export function findHedge(value) {
  const normalized = normalizeArabic(value);
  return HEDGES.find((phrase) => normalized.includes(normalizeArabic(phrase))) || null;
}

/**
 * Groups items from different outlets that report the same story. Each item is compared only
 * with a group's first item, so A~B and A~C never pull unrelated B and C together.
 * Errs towards not merging: a missed match shows as "likely", a wrong one as a false "confirmed".
 */
export function cluster(items) {
  const bags = new Map(items.map((item) => [item, bag(item.title)]));
  const df = new Map();
  for (const { words } of bags.values()) words.forEach((word) => df.set(word, (df.get(word) || 0) + 1));
  const total = items.length;
  const weight = (word) => Math.log((total + 1) / ((df.get(word) || 0) + 0.5)) + 0.1;

  const groups = [];
  for (const item of [...items].sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0))) {
    let best = null;
    let bestScore = MIN_SIMILARITY;
    for (const group of groups) {
      const lead = group[0];
      if (group.some((member) => member.outletId === item.outletId)) continue;
      if (Math.abs((lead.publishedAt || 0) - (item.publishedAt || 0)) > WINDOW_MS) continue;
      const score = similarity(bags.get(item), bags.get(lead), weight);
      if (score >= bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) best.push(item);
    else groups.push([item]);
  }
  return groups;
}

function countOutlets(count) {
  const digits = count.toLocaleString('ar-EG');
  if (count === 2) return 'مصدران مستقلان';
  if (count <= 10) return `${digits} مصادر مستقلة`;
  return `${digits} مصدراً مستقلاً`;
}

/** Picks a reliability level and the human-readable reasons shown in the story detail. */
export function assess(group, outletName) {
  const outlets = [...new Set(group.map((item) => item.outletId))];
  const names = outlets.map(outletName);
  const hedged = group.filter((item) => findHedge(`${item.title} ${item.summary}`));
  const method = 'التصنيف آلي: يقارن العناوين بين مصادرك، ولا يمثل تحققاً تحريرياً.';

  if (outlets.length >= 2 && hedged.length < group.length) {
    return {
      reliability: 'confirmed',
      why: [`نشر القصة ${countOutlets(outlets.length)}: ${names.join('، ')}.`, 'تتشارك العناوين الكلمات المفتاحية نفسها خلال ٤٨ ساعة.', method]
    };
  }
  if (hedged.length) {
    const phrase = findHedge(`${hedged[0].title} ${hedged[0].summary}`);
    return {
      reliability: 'unverified',
      why: [`صياغة الخبر تشير إلى معلومة غير محسومة («${phrase}»).`, outlets.length >= 2 ? `تتناقلها ${names.join('، ')} بالصيغة نفسها.` : `منشورة في ${names[0]} وحدها حتى الآن.`, method]
    };
  }
  return {
    reliability: 'likely',
    why: [`منشورة في ${names[0]} وحدها حتى الآن.`, 'لم نعثر على تغطية مطابقة في مصادرك الأخرى بعد.', method]
  };
}

import * as cheerio from 'cheerio';
import { request, absoluteUrl, createLimiter } from '../http.js';
import { clean, safeDecode, uniq } from '../normalize.js';
import { inIsrael } from '../config.js';
import { extractContacts } from '../contacts.js';

/* ------------------------------------------------------------------ */
/* /locations/ page: the filter dropdowns hold every city, type, etc. */
/* ------------------------------------------------------------------ */

const FILTER_ROLES = [
  { role: 'styles', test: /סגנון|style|club-activity/i },
  { role: 'plans', test: /מסלול|route|plan/i },
  { role: 'city', test: /עיר|city/i },
  { role: 'types', test: /פעילות|type|club-type|activity/i },
];

/**
 * Parse every <select> on the locations page.
 * Returns { city: [{value,label}], types: [...], styles: [...], plans: [...], raw: [...] }
 */
export function parseLocationsFilters(html) {
  const $ = cheerio.load(html);
  const out = { city: [], types: [], styles: [], plans: [], raw: [] };
  $('select').each((_, el) => {
    const $el = $(el);
    const options = $el
      .find('option')
      .map((_, o) => ({ value: clean($(o).attr('value') ?? ''), label: clean($(o).text()) }))
      .get();
    const placeholder = options[0]?.value === '' ? options[0].label : '';
    const labelText = [
      $el.attr('name'),
      $el.attr('id'),
      $el.attr('data-placeholder'),
      $el.attr('aria-label'),
      placeholder,
      $(`label[for="${$el.attr('id')}"]`).text(),
    ]
      .filter(Boolean)
      .join(' ');
    const real = options.filter((o) => o.label && o.value !== '' && o.label !== placeholder);
    const role = FILTER_ROLES.find((r) => r.test.test(labelText))?.role || null;
    out.raw.push({ name: $el.attr('name') || '', label: labelText, role, count: real.length });
    if (role && out[role].length === 0) out[role] = real;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Sitemaps                                                           */
/* ------------------------------------------------------------------ */

const SITEMAP_ENTRY_POINTS = ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml', '/club-sitemap.xml'];

function locs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim());
}

const isClubUrl = (u) => /\/club\/[^/]+\/?$/.test(new URL(u).pathname);
const isClubSitemap = (u) => /club/i.test(u) && !/club-(type|activity)|taxonom/i.test(u);

/** Walk sitemap indexes and return every /club/<slug>/ URL. */
export async function discoverClubUrls(baseUrl, { log = () => {} } = {}) {
  const found = new Set();
  const visited = new Set();

  async function walk(url, depth) {
    if (visited.has(url) || depth > 3) return;
    visited.add(url);
    let res;
    try {
      res = await request(url, { retries: 1, allowStatus: [404, 403, 410] });
    } catch (e) {
      log(`sitemap: ${url} failed (${e.message})`);
      return;
    }
    if (res.status !== 200 || !/<(urlset|sitemapindex)/i.test(res.text)) return;
    const entries = locs(res.text);
    if (/<sitemapindex/i.test(res.text)) {
      // Prefer club sitemaps, but fall back to walking everything if none is named "club".
      const children = entries.filter(isClubSitemap);
      for (const child of children.length ? children : entries) await walk(child, depth + 1);
    } else {
      entries.filter((u) => {
        try {
          return isClubUrl(u);
        } catch {
          return false;
        }
      }).forEach((u) => found.add(u));
    }
  }

  for (const p of SITEMAP_ENTRY_POINTS) {
    await walk(baseUrl + p, 0);
    if (found.size) break;
  }
  log(`sitemap: ${found.size} club URLs`);
  return [...found];
}

/* ------------------------------------------------------------------ */
/* Taxonomy archives: /club-type/<slug>/page/N/                       */
/* ------------------------------------------------------------------ */

/**
 * Crawl one taxonomy term archive and return the club URLs listed on it.
 * Also useful as a membership source: every club found belongs to this term.
 */
export async function crawlArchive(baseUrl, taxonomy, termSlug, { maxPages = 80 } = {}) {
  const urls = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const path = `/${taxonomy}/${encodeURIComponent(safeDecode(termSlug))}/${page > 1 ? `page/${page}/` : ''}`;
    let res;
    try {
      res = await request(baseUrl + path, { retries: 1, allowStatus: [404] });
    } catch {
      break;
    }
    if (res.status === 404) break;
    const $ = cheerio.load(res.text);
    const before = urls.size;
    $('a[href*="/club/"]').each((_, a) => {
      // Only count listing links, not ones in the site chrome (footer promos, menus).
      if ($(a).closest('header,footer,nav,aside,.elementor-location-header,.elementor-location-footer').length) return;
      const u = absoluteUrl($(a).attr('href'), baseUrl);
      if (u && isClubUrl(u)) urls.add(u.split('#')[0]);
    });
    if (urls.size === before) break;
  }
  return [...urls];
}


/**
 * WordPress's sanitize_html_class() strips "%" from post classes, so the Hebrew slug
 * "%d7%97%d7%93-..." arrives as "d797d793-...". Rebuild and decode it.
 */
export function decodeClassSlug(raw) {
  const s = safeDecode(raw);
  if (/[\u0590-\u05FF]/.test(s)) return s;
  // Hebrew is UTF-8 bytes D6xx/D7xx; decode those runs wherever they appear
  // (mixed names such as "קרוספיט(R)" leave Latin letters between them).
  const out = s.replace(/(?:d[67][0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m.replace(/(..)/g, '%$1'));
    } catch {
      return m;
    }
  });
  return /[\u0590-\u05FF]/.test(out) ? out : s;
}

/** Approximate WordPress sanitize_title() for Hebrew term names. */
export function wpSlugify(label) {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/['"״׳`’()®.,!?:;/\\]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const slugCandidates = (option) => {
  const out = [];
  const v = safeDecode(option.value || '');
  if (v && !/^\d+$/.test(v) && !/\s/.test(v)) out.push(v);
  out.push(wpSlugify(option.label));
  return [...new Set(out.filter(Boolean))];
};

/**
 * Crawl every term archive of a taxonomy and return Map(clubUrl → [term labels]).
 * Used to fill in categories when club pages and REST don't expose them.
 */
export async function crawlMemberships(baseUrl, taxonomy, options, { concurrency = 4, onProgress } = {}) {
  const limit = createLimiter(concurrency, 100);
  const membership = new Map();
  let done = 0;
  await Promise.all(
    options.map((opt) =>
      limit(async () => {
        for (const slug of slugCandidates(opt)) {
          const urls = await crawlArchive(baseUrl, taxonomy, slug);
          if (!urls.length) continue;
          for (const u of urls) membership.set(u, [...(membership.get(u) || []), opt.label]);
          break;
        }
        onProgress?.({ phase: 'Crawling category pages', done: ++done, total: options.length });
      })
    )
  );
  return membership;
}

/* ------------------------------------------------------------------ */
/* A single club page                                                 */
/* ------------------------------------------------------------------ */

const SECTION_HEADINGS = {
  info: /^מידע שימושי$/,
  hours: /^שעות (פתיחה|פעילות)$/,
  notes: /^חשוב לדעת$/,
  plans: /^מסלולים$/,
  address: /^כתובת$/,
  stop: /^(דברו איתנו|צור קשר|מסלולים|כתובת)$/,
};

const DAY_LINE = /(ימ(ים|י)|יום|שישי|שבת|ראשון|שני|שלישי|רביעי|חמישי|א׳|א'|ה׳|ה')/;

/** Extract coordinates embedded anywhere in the page (data attributes, JSON, map links). */
export function findCoordinates(html) {
  const patterns = [
    /data-lat(?:itude)?=["'](-?\d+\.\d+)["'][^>]*?data-(?:lng|lon|long|longitude)=["'](-?\d+\.\d+)["']/i,
    /data-(?:lng|lon|long|longitude)=["'](-?\d+\.\d+)["'][^>]*?data-lat(?:itude)?=["'](-?\d+\.\d+)["']/i, // reversed
    /["']lat(?:itude)?["']\s*:\s*["']?(-?\d+\.\d+)["']?\s*,\s*["'](?:lng|lon|long|longitude)["']\s*:\s*["']?(-?\d+\.\d+)/i,
    /[?&;](?:q|ll|center|daddr|destination|query)=(-?\d{1,2}\.\d{3,})(?:,|%2C)\s*(-?\d{1,3}\.\d{3,})/i,
    /@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,}),\d+z/i,
    /!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/i,
  ];
  for (const [i, re] of patterns.entries()) {
    const m = html.match(re);
    if (!m) continue;
    let lat = parseFloat(m[1]);
    let lng = parseFloat(m[2]);
    if (i === 1) [lat, lng] = [lng, lat];
    if (inIsrael(lat, lng)) return { lat, lng };
  }
  return null;
}

/** Leaf text blocks of the main content, in document order. */
function textBlocks($) {
  const blocks = [];
  const root = $('main').length ? $('main') : $('body');
  root
    .find('h1,h2,h3,h4,h5,h6,p,li,.elementor-icon-list-text,.elementor-text-editor,.jet-listing-dynamic-field__content')
    .each((_, el) => {
      const $el = $(el);
      // Skip containers whose children we will visit anyway.
      if ($el.find('h1,h2,h3,h4,h5,h6,p,li,.elementor-icon-list-text').length) return;
      if ($el.closest('header,footer,nav,form,.elementor-location-header,.elementor-location-footer').length) return;
      const text = clean($el.text());
      if (!text) return;
      blocks.push({ tag: el.tagName.toLowerCase(), text, isHeading: /^h[1-6]$/i.test(el.tagName) });
    });
  // Remove immediate duplicates (Elementor renders desktop + mobile copies).
  return blocks.filter((b, i) => i === 0 || b.text !== blocks[i - 1].text);
}

/**
 * Parse a club page into a partial record.
 * Freefit club pages (Elementor) look like:
 *   h2 name, address line, description, "מידע שימושי" > li address,
 *   "שעות פתיחה" > day lines, "חשוב לדעת" > notes, "מסלולים" > ?route= links
 */
export function parseClubPage(html, url, { termNames = {} } = {}) {
  const $ = cheerio.load(html);
  const rec = { url, types: [], styles: [], plans: [], hours: [] };

  const ogTitle = $('meta[property="og:title"]').attr('content');
  const title = clean($('title').text()).split(/\s+[–|-]\s+freefit/i)[0];
  rec.name = clean(ogTitle?.split(/\s+[–|-]\s+freefit/i)[0]) || title || clean($('h1').first().text());

  // Taxonomy membership from WordPress post classes, e.g. "club-type-חדר-כושר".
  const classes = `${$('body').attr('class') || ''} ${$('article').attr('class') || ''} ${$('[class*="type-club"]').first().attr('class') || ''}`;
  const pidMatch = classes.match(/(?:postid|post)-(\d+)/);
  if (pidMatch) rec.id = Number(pidMatch[1]);
  for (const cls of classes.split(/\s+/)) {
    const m = cls.match(/^(club-type|club-activity|club-city|club-route|city|route)-(.+)$/);
    if (!m) continue;
    const slug = decodeClassSlug(m[2]);
    const name = termNames[`${m[1]}:${slug}`] || termNames[slug] || slug.replace(/-/g, ' ');
    if (m[1] === 'club-type') rec.types.push(name);
    else if (m[1] === 'club-activity') rec.styles.push(name);
    else if (/route/.test(m[1])) rec.plans.push(slug);
    else rec.city = rec.city || name;
  }

  // Plans: links to /locations/?route=xxx
  $('a[href*="route="]').each((_, a) => {
    try {
      const r = new URL($(a).attr('href'), url).searchParams.get('route');
      if (r) rec.plans.push(r);
    } catch {}
  });

  const blocks = textBlocks($);
  const stopAt = blocks.findIndex((b) => b.isHeading && /^דברו איתנו$/.test(b.text));
  const content = stopAt > 0 ? blocks.slice(0, stopAt) : blocks;

  const headingIdx = (re, from = 0) => content.findIndex((b, i) => i >= from && b.isHeading && re.test(b.text));
  const sectionAfter = (re) => {
    const i = headingIdx(re);
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < content.length && !content[j].isHeading; j++) out.push(content[j].text);
    return out;
  };

  // Address: "מידע שימושי" list, else the line right after the name heading.
  const info = sectionAfter(SECTION_HEADINGS.info);
  const nameIdx = content.findIndex((b) => b.isHeading && b.text === rec.name);
  const afterName = nameIdx >= 0 ? content[nameIdx + 1] : null;
  const looksLikeAddress = (t) => t && t.length < 120 && (/,/.test(t) || /\d/.test(t)) && !DAY_LINE.test(t);
  rec.address = info.find(looksLikeAddress) || (afterName && !afterName.isHeading && looksLikeAddress(afterName.text) ? afterName.text : '');

  // Description: first long paragraph after the address line.
  if (nameIdx >= 0) {
    const desc = content.slice(nameIdx + 1).find((b) => !b.isHeading && b.text.length > 80 && b.text !== rec.address);
    if (desc) rec.description = desc.text;
  }

  rec.hours = uniq(sectionAfter(SECTION_HEADINGS.hours).filter((t) => /\d{1,2}[:.]\d{2}/.test(t) && t.length < 120));
  rec.notes = sectionAfter(SECTION_HEADINGS.notes).join('\n');

  // Image: featured/hero upload, not the site chrome.
  const imgs = $('img')
    .map((_, i) => $(i).attr('src') || $(i).attr('data-src') || '')
    .get()
    .filter((s) => /\/wp-content\/uploads\//.test(s) && !/(logo|footer|favicon|app-store|google-play|hero-)/i.test(s));
  rec.image = imgs[0] ? absoluteUrl(imgs[0], url) : $('meta[property="og:image"]').attr('content') || '';

  const coords = findCoordinates(html);
  if (coords) Object.assign(rec, coords, { geo: 'site' });

  rec.contact = clubPageContacts($, url, content, rec.name);

  rec.types = uniq(rec.types);
  rec.styles = uniq(rec.styles);
  return rec;
}


const CHROME = 'header,footer,nav,form,aside,.elementor-location-header,.elementor-location-footer';

/**
 * Public contacts of the business on its Freefit page: links and text from the page's own
 * content only (no site header/footer/menus/forms, and not Freefit's "דברו איתנו" section).
 */
function clubPageContacts($, url, content, name) {
  const heading = $('h1,h2,h3').filter((_, h) => /^דברו איתנו$/.test(clean($(h).text()))).first();
  if (heading.length) {
    const section = heading.closest('section,.elementor-section,.e-con,.e-parent,.elementor-top-section');
    const holdsBusiness = section.find('h1,h2,h3').filter((_, h) => clean($(h).text()) === name).length > 0;
    if (section.length && !holdsBusiness) section.find('a').attr('data-ff-skip', '1');
  }
  const root = $('main').length ? $('main') : $('body');
  const links = root
    .find('a[href]')
    .filter((_, a) => !$(a).attr('data-ff-skip') && !$(a).closest(CHROME).length)
    .map((_, a) => {
      let href = $(a).attr('href');
      try {
        href = new URL(href, url).toString();
      } catch {}
      return { href, text: clean(`${$(a).text()} ${$(a).attr('aria-label') || ''} ${$(a).attr('title') || ''}`) };
    })
    .get();
  const text = content.map((b) => b.text).join('\n');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  return extractContacts({ links, text, source: 'freefit', sourceUrl: url, ownHosts: [host] });
}

/** Fetch and parse many club pages with bounded concurrency. */
export async function scrapeClubPages(urls, { concurrency = 4, delayMs = 120, termNames, onProgress, log = () => {} } = {}) {
  const limit = createLimiter(concurrency, delayMs);
  let done = 0;
  const failures = [];
  const results = await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try {
          const { text } = await request(url);
          return parseClubPage(text, url, { termNames });
        } catch (e) {
          failures.push({ url, error: e.message });
          return null;
        } finally {
          done++;
          if (done % 10 === 0 || done === urls.length) onProgress?.({ phase: 'Reading club pages', done, total: urls.length });
        }
      })
    )
  );
  if (failures.length) log(`html: ${failures.length} club pages failed, e.g. ${failures[0].url}: ${failures[0].error}`);
  return results.filter(Boolean);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { request, createLimiter } from '../http.js';
import { extractContacts, mergeContacts, emptyContact } from '../contacts.js';
import { clean } from '../normalize.js';

const CONTACT_LINK = /צור[\s-]*קשר|יצירת[\s-]*קשר|דברו[\s-]*איתנו|contact|about|אודות/i;
const MAX_HTML = 2_000_000;

/** Visible text and links of an HTML page. */
export function pageContent(html, baseUrl) {
  const $ = cheerio.load(html.slice(0, MAX_HTML));
  $('script,style,noscript,svg,template').remove();
  const links = $('a[href]')
    .map((_, a) => {
      const raw = $(a).attr('href') || '';
      let href = raw;
      try {
        href = new URL(raw, baseUrl).toString();
      } catch {}
      const label = clean(`${$(a).text()} ${$(a).attr('aria-label') || ''} ${$(a).attr('title') || ''}`);
      return { href, text: label };
    })
    .get();
  // Separate blocks so labels and numbers from unrelated elements don't run together.
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,h5,h6,section,footer,header,td,span').each((_, el) => {
    $(el).append('\n');
  });
  const text = $('body').text().replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*/g, '\n');
  return { $, links, text };
}

/** Minimal robots.txt check for the "*" group: is `pathname` disallowed? */
export function robotsDisallows(robotsTxt, pathname = '/') {
  let applies = false;
  const rules = [];
  for (const line of String(robotsTxt).split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    const [k, ...rest] = l.split(':');
    const v = rest.join(':').trim();
    if (!k) continue;
    if (/^user-agent$/i.test(k)) applies = v === '*';
    else if (applies && /^disallow$/i.test(k) && v) rules.push({ allow: false, p: v });
    else if (applies && /^allow$/i.test(k) && v) rules.push({ allow: true, p: v });
  }
  const match = rules.filter((r) => pathname.startsWith(r.p)).sort((a, b) => b.p.length - a.p.length)[0];
  return !!match && !match.allow;
}

/**
 * Visit a business website (home page + one contact page on the same host) and
 * return { ok, finalUrl, contact, error }.
 */
export async function crawlBusinessSite(url, { timeoutMs = 12000 } = {}) {
  let start;
  try {
    start = new URL(url);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  try {
    const robots = await request(`${start.origin}/robots.txt`, { retries: 0, timeoutMs: 6000, allowStatus: [401, 403, 404, 410] }).catch(() => null);
    if (robots?.status === 200 && robotsDisallows(robots.text, start.pathname || '/')) {
      return { ok: false, error: 'blocked by robots.txt' };
    }

    const home = await request(url, { retries: 1, timeoutMs });
    if (!/html/i.test(home.headers.get('content-type') || 'text/html')) return { ok: false, error: 'not an HTML page' };
    const finalUrl = home.url || url;
    const host = new URL(finalUrl).hostname;
    const sourceUrl = finalUrl;
    const page = pageContent(home.text, finalUrl);
    let contact = extractContacts({ links: page.links, text: page.text, source: 'site', sourceUrl, ownHosts: [host] });

    // One contact/about page on the same host, if the home page links to one.
    const contactLink = page.links.find((l) => {
      try {
        const u = new URL(l.href);
        return u.hostname === host && u.toString() !== finalUrl && (CONTACT_LINK.test(l.text) || CONTACT_LINK.test(decodeURIComponent(u.pathname)));
      } catch {
        return false;
      }
    });
    if (contactLink) {
      try {
        const p = await request(contactLink.href, { retries: 0, timeoutMs });
        const c2 = pageContent(p.text, contactLink.href);
        contact = mergeContacts(contact, extractContacts({ links: c2.links, text: c2.text, source: 'site', sourceUrl: contactLink.href, ownHosts: [host] }));
      } catch {
        /* the home page is enough */
      }
    }
    // The site itself is the website; other "website" links on it are partners/credits.
    contact.websites = [{ url: finalUrl, kind: 'website', source: 'site' }];
    return { ok: true, finalUrl, contact };
  } catch (e) {
    return { ok: false, error: e.message, contact: emptyContact() };
  }
}

/** Disk cache of crawled sites (url → result), refreshed after `ttlDays`. */
export class SiteCache {
  constructor(file, ttlDays = 14) {
    this.file = file;
    this.ttlMs = ttlDays * 864e5;
    this.map = new Map();
  }
  async load() {
    try {
      this.map = new Map(Object.entries(JSON.parse(await fs.readFile(this.file, 'utf8'))));
    } catch {
      this.map = new Map();
    }
    return this;
  }
  get(url) {
    const v = this.map.get(url);
    return v && Date.now() - Date.parse(v.fetchedAt) < this.ttlMs ? v : null;
  }
  set(url, v) {
    this.map.set(url, { ...v, fetchedAt: new Date().toISOString() });
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.map)));
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}

/** Crawl many sites with bounded concurrency, using the cache. Returns Map(url → result). */
export async function crawlSites(urls, { cache, concurrency = 6, onProgress, log = () => {} } = {}) {
  const unique = [...new Set(urls)];
  const out = new Map();
  const limit = createLimiter(concurrency, 50);
  let done = 0;
  let fetched = 0;
  await Promise.all(
    unique.map((url) =>
      limit(async () => {
        let r = cache?.get(url);
        if (!r) {
          r = await crawlBusinessSite(url);
          cache?.set(url, r);
          fetched++;
        }
        out.set(url, r);
        if (++done % 10 === 0 || done === unique.length) onProgress?.({ phase: 'Reading business websites', done, total: unique.length });
      })
    )
  );
  const failed = [...out.values()].filter((r) => !r.ok).length;
  log(`sites: ${unique.length} sites (${fetched} fetched, ${unique.length - fetched} from cache, ${failed} unreachable or blocked)`);
  return out;
}

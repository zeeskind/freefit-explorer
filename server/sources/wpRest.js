import { getJson, request, createLimiter } from '../http.js';
import { clean, decodeEntities, stripTags, safeDecode, uniq } from '../normalize.js';
import { inIsrael } from '../config.js';

export class RestUnavailable extends Error {}

const DEFAULT_TAXONOMIES = [
  { slug: 'club-type', rest_base: 'club-type', name: 'סוג' },
  { slug: 'club-activity', rest_base: 'club-activity', name: 'פעילות' },
];

/**
 * Decide which normalized field a taxonomy feeds, from its slug and label.
 * Returns 'types' | 'styles' | 'plans' | 'city' | null.
 */
export function roleForTaxonomy(slug = '', name = '') {
  const s = `${slug} ${name}`.toLowerCase();
  if (/route|plan|package|מסלול|מנוי/.test(s)) return 'plans';
  if (/city|town|area|region|location|עיר|יישוב|אזור/.test(s)) return 'city';
  if (/activity|style|סגנון/.test(s)) return 'styles';
  if (/type|category|cat|סוג|קטגור|פעילות/.test(s)) return 'types';
  return null;
}

/** Walk any nested object looking for coordinates, address, city, hours and plans. */
export function scanFields(obj, depth = 0, found = {}) {
  if (!obj || typeof obj !== 'object' || depth > 5) return found;
  const keys = Object.keys(obj);

  // An object holding both a latitude and a longitude (ACF google_map, custom meta, etc.).
  const latKey = keys.find((k) => /^(lat|latitude|_?lat|geo_lat|map_lat)$/i.test(k));
  const lngKey = keys.find((k) => /^(lng|lon|long|longitude|_?lng|geo_lng|map_lng)$/i.test(k));
  if (latKey && lngKey && found.lat == null) {
    const lat = parseFloat(obj[latKey]);
    const lng = parseFloat(obj[lngKey]);
    if (inIsrael(lat, lng)) {
      found.lat = lat;
      found.lng = lng;
      if (typeof obj.address === 'string' && !found.address) found.address = clean(obj.address);
      if (typeof obj.city === 'string' && !found.city) found.city = clean(obj.city);
    }
  }

  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const str = String(v);
      if (!found.address && /(^|_)(address|full_address|street|כתובת)($|_)/i.test(k) && str.length > 3 && str.length < 200)
        found.address = clean(stripTags(str));
      else if (!found.city && /(^|_)(city|town|עיר)($|_)/i.test(k) && str.length < 60) found.city = clean(str);
      else if (!found.hours && /(hours|opening|שעות)/i.test(k)) found.hours = stripTags(str).split('\n');
      else if (!found.plans && /(route|plan|package|מסלול)/i.test(k)) found.plans = str.split(/[,|/\s]+/);
      else if (found.lat == null && /^(location|coordinates|latlng|geo|position)$/i.test(k)) {
        const m = str.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
        if (m && inIsrael(+m[1], +m[2])) {
          found.lat = +m[1];
          found.lng = +m[2];
        }
      }
    } else if (Array.isArray(v)) {
      if (!found.plans && /(route|plan|package|מסלול)/i.test(k) && v.every((x) => typeof x === 'string')) found.plans = v;
      else v.slice(0, 20).forEach((x) => scanFields(x, depth + 1, found));
    } else if (typeof v === 'object' && !/^(_links|_embedded|yoast_head_json|guid|content|excerpt|title)$/.test(k)) {
      scanFields(v, depth + 1, found);
    }
  }
  return found;
}

async function fetchAllPages(url, { perPage = 100, concurrency = 2, onPage } = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const first = await request(`${url}${sep}per_page=${perPage}&page=1`, {
    accept: 'application/json',
    allowStatus: [400, 401, 403, 404],
  });
  if (first.status !== 200) throw new RestUnavailable(`${url} answered ${first.status}`);
  let items;
  try {
    items = JSON.parse(first.text);
  } catch {
    throw new RestUnavailable(`${url} did not return JSON (blocked by a security plugin?)`);
  }
  if (!Array.isArray(items)) throw new RestUnavailable(`${url} did not return a list`);
  const totalPages = Number(first.headers.get('x-wp-totalpages')) || 1;
  onPage?.(1, totalPages);

  const limit = createLimiter(concurrency, 150);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      limit(async () => {
        const page = i + 2;
        const { json } = await getJson(`${url}${sep}per_page=${perPage}&page=${page}`);
        onPage?.(page, totalPages);
        return Array.isArray(json) ? json : [];
      })
    )
  );
  return items.concat(...rest);
}

/**
 * Try to load every club through the WordPress REST API.
 * Returns { records, meta } or throws RestUnavailable.
 */
export async function loadFromWpRest(baseUrl, { log = () => {}, onProgress } = {}) {
  const api = `${baseUrl}/wp-json/wp/v2`;

  // 1. Find the post type that holds the clubs.
  let typeSlug = 'club';
  let restBase = 'club';
  try {
    const { json: types } = await getJson(`${api}/types`, { retries: 1 });
    const t = Object.values(types || {}).find(
      (t) => t.slug === 'club' || /club|location|place/i.test(`${t.slug} ${t.rest_base}`)
    );
    if (t) {
      typeSlug = t.slug;
      restBase = t.rest_base || t.slug;
    }
    log(`REST: post type "${typeSlug}" at /${restBase}`);
  } catch (e) {
    log(`REST: /types unavailable (${e.message}); guessing /club`);
  }

  // 2. Its taxonomies.
  let taxonomies = DEFAULT_TAXONOMIES;
  try {
    const { json } = await getJson(`${api}/taxonomies?type=${encodeURIComponent(typeSlug)}`, { retries: 1 });
    const list = Object.values(json || {}).map((t) => ({ slug: t.slug, rest_base: t.rest_base || t.slug, name: t.name }));
    if (list.length) taxonomies = list;
  } catch (e) {
    log(`REST: /taxonomies unavailable (${e.message}); using defaults`);
  }
  taxonomies = taxonomies.map((t) => ({ ...t, role: roleForTaxonomy(t.slug, t.name) }));
  log(`REST: taxonomies ${taxonomies.map((t) => `${t.slug}→${t.role}`).join(', ')}`);

  // 3. Term dictionaries (id → name).
  const terms = {};
  for (const t of taxonomies) {
    try {
      const list = await fetchAllPages(`${api}/${t.rest_base}?_fields=id,name,slug`);
      terms[t.rest_base] = new Map(list.map((x) => [x.id, decodeEntities(x.name)]));
    } catch (e) {
      log(`REST: terms for ${t.slug} unavailable (${e.message})`);
      terms[t.rest_base] = new Map();
    }
  }

  // 4. All posts.
  const posts = await fetchAllPages(`${api}/${restBase}?_embed=wp:featuredmedia`, {
    onPage: (p, total) => onProgress?.({ phase: 'Downloading club list (REST)', done: p, total }),
  });
  log(`REST: ${posts.length} posts`);

  const records = posts.map((p) => mapPost(p, taxonomies, terms));
  return {
    records,
    meta: { source: 'wp-rest', restBase, taxonomies, samplePost: posts[0] ? summarizeKeys(posts[0]) : null },
  };
}

export function mapPost(p, taxonomies, terms) {
  const r = {
    id: p.id,
    slug: safeDecode(p.slug || ''),
    url: p.link,
    name: clean(stripTags(p.title?.rendered || '')),
    description: stripTags(p.content?.rendered || ''),
    image:
      p._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
      p.jetpack_featured_media_url ||
      p.yoast_head_json?.og_image?.[0]?.url ||
      '',
    types: [],
    styles: [],
    plans: [],
  };
  for (const t of taxonomies) {
    const ids = Array.isArray(p[t.rest_base]) ? p[t.rest_base] : [];
    const names = ids.map((id) => terms[t.rest_base]?.get(id)).filter(Boolean);
    if (!names.length || !t.role) continue;
    if (t.role === 'city') r.city = r.city || names[0];
    else r[t.role] = uniq([...(r[t.role] || []), ...names]);
  }
  const f = scanFields({ acf: p.acf, meta: p.meta, ...p });
  if (f.lat != null) Object.assign(r, { lat: f.lat, lng: f.lng, geo: 'site' });
  if (f.address) r.address = f.address;
  if (f.city && !r.city) r.city = f.city;
  if (f.hours) r.hours = f.hours;
  if (f.plans && !r.plans.length) r.plans = f.plans;
  return r;
}

function summarizeKeys(post) {
  const out = {};
  for (const [k, v] of Object.entries(post)) {
    out[k] = Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 12).join(', ')}}` : typeof v;
  }
  return out;
}

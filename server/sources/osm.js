/**
 * Contact details from OpenStreetMap (no API key).
 *
 * Freefit's business pages publish no phones, WhatsApp or websites, so contacts come from
 * OpenStreetMap: one Overpass query returns every named sport/fitness venue in Israel with
 * its tags (phone, website, contact:whatsapp, contact:instagram, …). Each Freefit business
 * is matched to a venue by distinctive name words AND distance; ambiguous matches are skipped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyContact, normalizePhone, parseWhatsappUrl, classifyUrl } from '../contacts.js';
import { ISRAEL_BBOX } from '../config.js';

const BBOX = `${ISRAEL_BBOX.south},${ISRAEL_BBOX.west},${ISRAEL_BBOX.north},${ISRAEL_BBOX.east}`;

export const OVERPASS_QUERY = `[out:json][timeout:180];
(
  nwr["name"]["leisure"~"^(fitness_centre|sports_centre|swimming_pool|dance|sports_hall|horse_riding|water_park|track)$"](${BBOX});
  nwr["name"]["sport"~"yoga|pilates|crossfit|fitness|martial_arts|boxing|kickboxing|karate|judo|taekwondo|aikido|mma|climbing|bouldering|swimming|dance|surfing|padel|tennis|gymnastics|capoeira|trampoline"](${BBOX});
  nwr["name"]["amenity"~"^(dojo|gym)$"](${BBOX});
  nwr["name"]["club"="sport"](${BBOX});
);
out center tags;`;

const KEEP_TAGS = /^(name|name:he|name:en|alt_name|brand|phone|mobile|contact:(phone|mobile|whatsapp|website|email|instagram|facebook|tiktok|youtube)|website|url|email|addr:city|addr:street|addr:housenumber)$/;

/** Download (or reuse) the venue list. Returns [{ id, type, lat, lng, tags }]. */
export async function loadOsmVenues({ endpoints, cacheFile, ttlDays = 7, userAgent, log = () => {} }) {
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (Date.now() - Date.parse(cached.fetchedAt) < ttlDays * 864e5 && cached.venues?.length) {
      log(`osm: ${cached.venues.length} venues from cache (${cached.fetchedAt.slice(0, 10)})`);
      return cached.venues;
    }
  } catch {}
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
        signal: AbortSignal.timeout(240000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const venues = (body.elements || [])
        .map((e) => ({
          id: e.id,
          type: e.type,
          lat: e.lat ?? e.center?.lat,
          lng: e.lon ?? e.center?.lon,
          tags: Object.fromEntries(Object.entries(e.tags || {}).filter(([k]) => KEEP_TAGS.test(k))),
        }))
        .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng) && (v.tags.name || v.tags['name:he'] || v.tags['name:en']));
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), venues }));
      log(`osm: downloaded ${venues.length} venues from ${new URL(url).hostname}`);
      return venues;
    } catch (e) {
      lastErr = e;
      log(`osm: ${url} failed (${e.message})`);
    }
  }
  throw lastErr || new Error('no Overpass endpoint');
}

/* ------------------------------ matching ------------------------------ */

const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const fold = (w) => w.toLowerCase().replace(/[ךםןףץ]/g, (c) => FINALS[c]);
// Words that describe the activity or place type rather than identify the business.
const GENERIC_RAW = new Set(
  `פילאטיס מכשירים מכשיר מזרן סטודיו סטדיו לנשים נשים לגברים גברים בלבד חדר כושר מועדון מועדוני יוגה אימון אימוני אימונים
   פונקציונלי פונקציונאלי קרוספיט בריכה בריכת שחיה שחייה ספורט מרכז קאנטרי קלאב ריקוד מחול לחימה אומנויות אמנויות אגרוף
   שיעורי שיעור בוטיק מתחם בית של עם ו ה ב ל את אזור סניף החדש חדש הכושר הספורט לילדים ילדים נוער ותנועה תנועה וסטודיו
   studio pilates yoga gym fitness club center centre the crossfit box sport sports and of reformer boutique dance swim
   swimming pool martial arts training academy house space`.split(/\s+/)
);
const GENERIC = new Set([...GENERIC_RAW].map(fold));
const STRIP_PREFIX = /^[והבלמש](?=[\u05d0-\u05ea]{3,})/;

export function nameTokens(name, extraGeneric = new Set()) {
  const extra = new Set([...extraGeneric].map(fold));
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7\u0300-\u036f]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .map((t) => (GENERIC.has(t) || extra.has(t) ? t : t.replace(STRIP_PREFIX, '')))
    .filter((t) => t.length >= 2 && !GENERIC.has(t) && !extra.has(t) && !/^\d+$/.test(t));
}

function venueNames(v) {
  return [v.tags.name, v.tags['name:he'], v.tags['name:en'], v.tags.alt_name, v.tags.brand].filter(Boolean);
}

export function distanceM(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Number of distinctive words shared by two names (best over the venue's name variants). */
export function nameScore(freefitName, venue, extraGeneric) {
  const a = new Set(nameTokens(freefitName, extraGeneric));
  let best = 0;
  for (const n of venueNames(venue)) {
    const b = nameTokens(n, extraGeneric);
    if (!b.length) continue;
    // Exact word match, or the same letters-only word with a suffix ("פיור" / "פיורה"); never across digits.
    const prefixOk = (x, t) => /^\p{L}+$/u.test(x) && /^\p{L}+$/u.test(t) && Math.min(x.length, t.length) >= 5 && (x.startsWith(t) || t.startsWith(x));
    const shared = b.filter((t) => a.has(t) || [...a].some((x) => prefixOk(x, t))).length;
    best = Math.max(best, shared);
  }
  return best;
}

/** Grid index for fast "venues near a point" lookups. */
export function indexVenues(venues, cellDeg = 0.05) {
  const grid = new Map();
  const key = (lat, lng) => `${Math.floor(lat / cellDeg)}:${Math.floor(lng / cellDeg)}`;
  for (const v of venues) {
    const k = key(v.lat, v.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(v);
  }
  return {
    near(lat, lng, radiusM) {
      const r = Math.ceil(radiusM / 111000 / cellDeg);
      const ci = Math.floor(lat / cellDeg);
      const cj = Math.floor(lng / cellDeg);
      const out = [];
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) out.push(...(grid.get(`${i}:${j}`) || []));
      return out;
    },
  };
}

/**
 * Find the OpenStreetMap venue for a Freefit business, or null.
 * Exact pins: within 300 m and at least one distinctive shared name word.
 * City-level pins: within 6 km and at least two shared words (one word if it is long and
 * the only candidate), because location alone proves little there.
 */
export function matchVenue(item, index, { extraGeneric } = {}) {
  if (item.lat == null) return null;
  const precise = item.geo !== 'city';
  const radius = precise ? 300 : 6000;
  const candidates = index
    .near(item.lat, item.lng, radius)
    .map((v) => ({ v, d: distanceM(item, v), s: nameScore(item.name, v, extraGeneric) }))
    .filter((c) => c.d <= radius && c.s >= 1);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.s - a.s || a.d - b.d);
  const [best, second] = candidates;
  if (!precise) {
    const longWord = nameTokens(item.name, extraGeneric).some((t) => t.length >= 5);
    const strong = best.s >= 2 || (best.s === 1 && longWord && candidates.length === 1);
    if (!strong) return null;
  }
  // Two different venues equally good: don't guess.
  if (second && second.s === best.s && Math.abs(second.d - best.d) < 30 && second.v.id !== best.v.id) return null;
  return { venue: best.v, distance: Math.round(best.d), score: best.s };
}

/** Contact object from a venue's tags (source "osm"). */
export function venueContact(v) {
  const c = emptyContact();
  const sourceUrl = `https://www.openstreetmap.org/${v.type}/${v.id}`;
  const t = v.tags;
  const split = (s) => String(s || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  for (const raw of [...split(t.phone), ...split(t['contact:phone']), ...split(t.mobile), ...split(t['contact:mobile'])]) {
    const p = normalizePhone(raw);
    if (p && !c.phones.some((x) => x.e164 === p.e164)) c.phones.push({ ...p, source: 'osm', sourceUrl });
  }
  // contact:whatsapp is an explicit WhatsApp tag; it may be a number or a wa.me link.
  for (const raw of split(t['contact:whatsapp'])) {
    const p = /^https?:/i.test(raw) ? parseWhatsappUrl(raw) : normalizePhone(raw);
    if (p?.e164 && !c.whatsapp.some((x) => x.e164 === p.e164)) {
      c.whatsapp.push({ e164: p.e164, display: p.display, url: `https://wa.me/${p.e164.slice(1)}`, evidence: 'osm', source: 'osm', sourceUrl });
    }
  }
  for (const raw of [...split(t.email), ...split(t['contact:email'])]) {
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(raw)) c.emails.push({ email: raw.toLowerCase(), source: 'osm', sourceUrl });
  }
  for (const raw of [t.website, t['contact:website'], t.url].filter(Boolean)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const kind = classifyUrl(url);
    if (kind === 'website' || kind === 'links' || kind === 'booking') {
      if (!c.websites.some((w) => w.url === url)) c.websites.push({ url, kind, source: 'osm' });
    } else if (kind && kind !== 'whatsapp' && !c.social[kind]) c.social[kind] = url;
  }
  for (const k of ['instagram', 'facebook', 'tiktok', 'youtube']) {
    const raw = t[`contact:${k}`];
    if (!raw || c.social[k]) continue;
    const host = { instagram: 'instagram.com', facebook: 'facebook.com', tiktok: 'tiktok.com/@', youtube: 'youtube.com/' }[k];
    c.social[k] = /^https?:/i.test(raw) ? raw : `https://www.${host}${host.endsWith('/') || host.endsWith('@') ? '' : '/'}${raw.replace(/^@/, '')}`;
  }
  return c;
}

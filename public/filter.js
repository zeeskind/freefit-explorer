// Pure functions: no DOM, no Leaflet. Imported by app.js and by the Node tests.

const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/** Lowercase, strip niqqud/punctuation, fold Hebrew final letters. */
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7\u0300-\u036f]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/["'״׳`’‘“”\-–—_.,:;!?()[\]/\\|+&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function emptyFilters() {
  return { q: '', plan: '', groups: new Set(), cities: new Set(), types: new Set(), styles: new Set(), amenities: new Set() };
}

/** Precompute a search string on every item (once per dataset). */
export function indexItems(items) {
  for (const it of items) {
    it._search = normalizeText([it.name, it.address, it.city, ...it.types, ...it.styles, ...it.amenities].join(' '));
  }
  return items;
}

const anyOf = (set, list) => set.size === 0 || list.some((v) => set.has(v));
const allOf = (set, list) => {
  if (set.size === 0) return true;
  for (const v of set) if (!list.includes(v)) return false;
  return true;
};

/**
 * Does the item pass every filter except `skip`?
 * Facets combine with AND; values inside a facet combine with OR,
 * except amenities, where every selected amenity is required.
 */
export function matches(it, f, tokens, skip = null) {
  if (tokens.length && !tokens.every((t) => it._search.includes(t))) return false;
  if (skip !== 'plan' && f.plan && !it.plans.includes(f.plan)) return false;
  if (skip !== 'groups' && f.groups.size && !f.groups.has(it.group)) return false;
  if (skip !== 'cities' && f.cities.size && !f.cities.has(it.city)) return false;
  if (skip !== 'types' && !anyOf(f.types, it.types)) return false;
  if (skip !== 'styles' && !anyOf(f.styles, it.styles)) return false;
  if (skip !== 'amenities' && !allOf(f.amenities, it.amenities)) return false;
  return true;
}

export const tokenize = (q) => normalizeText(q).split(' ').filter(Boolean);

export function applyFilters(items, f) {
  const tokens = tokenize(f.q);
  return items.filter((it) => matches(it, f, tokens));
}

/**
 * Counts for each value of a facet, given all *other* active filters.
 * This keeps every option honest: the number shown is what you get if you pick it.
 */
export function facetCounts(items, f, facet) {
  const tokens = tokenize(f.q);
  const counts = new Map();
  const key = { cities: 'city', plan: 'plans', groups: 'group' }[facet] || facet;
  for (const it of items) {
    if (!matches(it, f, tokens, facet)) continue;
    const vals = Array.isArray(it[key]) ? it[key] : it[key] ? [it[key]] : [];
    for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

export function activeFilterCount(f) {
  return (f.q ? 1 : 0) + (f.plan ? 1 : 0) + f.groups.size + f.cities.size + f.types.size + f.styles.size + f.amenities.size;
}

export function inBounds(it, b) {
  return it.lat != null && it.lat >= b.south && it.lat <= b.north && it.lng >= b.west && it.lng <= b.east;
}

export function distanceKm(a, b) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Sort by distance from `origin` when given (unlocated items last), else by name. */
export function sortItems(list, origin) {
  if (!origin) return [...list].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const d = (it) => (it.lat == null ? Infinity : distanceKm(origin, it));
  return list.map((it) => [d(it), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

/* ---------------------------- URL state ---------------------------- */

const SEP = '|';

export function filtersToParams(f, extra = {}) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.plan) p.set('plan', f.plan);
  if (f.groups.size) p.set('group', [...f.groups].join(SEP));
  if (f.cities.size) p.set('city', [...f.cities].join(SEP));
  if (f.types.size) p.set('type', [...f.types].join(SEP));
  if (f.styles.size) p.set('style', [...f.styles].join(SEP));
  if (f.amenities.size) p.set('amenity', [...f.amenities].join(SEP));
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v);
  return p;
}

export function paramsToFilters(p) {
  const set = (k) => new Set((p.get(k) || '').split(SEP).filter(Boolean));
  return {
    q: p.get('q') || '',
    plan: p.get('plan') || '',
    groups: set('group'),
    cities: set('city'),
    types: set('type'),
    styles: set('style'),
    amenities: set('amenity'),
  };
}

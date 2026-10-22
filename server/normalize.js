/**
 * Normalized location schema served to the frontend:
 * {
 *   id, slug, url, name, address, city, lat, lng,
 *   geo: 'site' | 'exact' | 'city' | null,   // where the coordinates came from
 *   types: string[],      // Freefit "פעילות" (club-type taxonomy)
 *   styles: string[],     // Freefit "סגנון פעילות" (club-activity taxonomy), minus amenities
 *   amenities: string[],  // facility terms split out of the styles list
 *   plans: string[],      // SMART | PLUS | PRO | MAX
 *   group: string,        // colour group for the map
 *   hours: string[], notes: string, description: string, image: string
 * }
 */

export const PLAN_ORDER = ['SMART', 'PLUS', 'PRO', 'MAX'];

// Facility terms that live inside Freefit's "activity style" list.
export const AMENITY_TERMS = [
  'חניה',
  'מקלחות',
  'מלתחות אישיות',
  'מגבות',
  'סאונה',
  "ג'קוזי",
  'ספא',
  'מרכז וולנס',
  'קפיטריה',
  'עיסויים',
  'מיטות שיזוף',
  'מיטת שיזוף',
  'מקלחת שיזוף',
  'חוף ים פרטי',
  'בריכה מחוממת',
  'בריכה סגורה',
  'אימון עם בייביסיטר',
  'הסרת שיער בלייזר',
];

// Map colour groups. Order matters: the first match wins.
export const GROUPS = [
  { id: 'water', label: 'בריכות וספורט ימי', color: '#1D6FD8', kw: ['בריכה', 'ספורט ימי', 'שחי', 'גלישה', 'סאפ', 'sup', 'שייט', 'קיאק'] },
  { id: 'combat', label: 'אומנויות לחימה', color: '#C2362B', kw: ['לחימה', 'אגרוף', 'קרב מגע', 'mma', 'קיקבוקס', 'kickbox', "ג'ודו", 'קראטה', 'טאקוונדו', "ג'יוג'יטסו"] },
  { id: 'functional', label: 'קרוספיט ופונקציונלי', color: '#D4660B', kw: ['קרוספיט', 'crossfit', 'פונקציונ', 'functional', 'hiit', 'בוטקמפ', 'bootcamp'] },
  { id: 'studio', label: 'יוגה, פילאטיס וסטודיו', color: '#13998F', kw: ['פילאטיס', 'pilates', 'יוגה', 'yoga', 'סטודיו', 'ריקוד', 'barre', 'מחול'] },
  { id: 'outdoor', label: 'אימוני חוץ ואטרקציות', color: '#3E8E2F', kw: ['חוץ', 'outdoor', 'אטרקצי', 'טיפוס', 'נינג', 'ריצה', 'אופניים'] },
  { id: 'wellness', label: 'וולנס והתאוששות', color: '#8A55B8', kw: ['וולנס', 'ספא', 'קרח', 'ice bath', 'מדיטציה', 'נשימ'] },
  { id: 'gym', label: 'חדרי כושר', color: '#0F3D5E', kw: ['חדר כושר', 'מועדון כושר', 'gym', 'קאנטרי', 'משקולות'] },
];
export const OTHER_GROUP = { id: 'other', label: 'אחר', color: '#6B7A86' };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripTags(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export const clean = (s) => (s == null ? '' : decodeEntities(String(s)).replace(/\s+/g, ' ').trim());

export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function slugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return safeDecode(parts[parts.length - 1] || '');
  } catch {
    return '';
  }
}

export function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const c = clean(v);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export function normalizePlans(list) {
  const set = new Set(
    (list || [])
      .map((p) => clean(p).toUpperCase())
      .filter((p) => PLAN_ORDER.includes(p))
  );
  return PLAN_ORDER.filter((p) => set.has(p));
}

const amenitySet = new Set(AMENITY_TERMS);
export function splitAmenities(styles) {
  const out = { styles: [], amenities: [] };
  for (const s of uniq(styles)) (amenitySet.has(s) ? out.amenities : out.styles).push(s);
  return out;
}

export function groupFor(types = [], styles = []) {
  const test = (list) => {
    const hay = list.join(' | ').toLowerCase();
    if (!hay) return null;
    return GROUPS.find((g) => g.kw.some((k) => hay.includes(k.toLowerCase())))?.id || null;
  };
  return test(types) || test(styles) || OTHER_GROUP.id;
}

const normCity = (s) =>
  clean(s)
    .replace(/[־–—]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/["'״׳]/g, '')
    .toLowerCase();

/**
 * Pick the city for an address. Prefers a known Freefit city name that appears in the
 * address (longest match wins); falls back to the last comma-separated segment.
 */
export function resolveCity(address, knownCities = []) {
  const addr = clean(address);
  if (!addr) return '';
  const hay = normCity(addr);
  let best = '';
  for (const c of knownCities) {
    const n = normCity(c);
    if (n.length > 1 && hay.includes(n) && n.length > normCity(best).length) best = c;
  }
  if (best) return best;
  const parts = addr.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!/\d/.test(last) && last.length <= 30) return last;
  }
  return '';
}

/** Merge b into a: fill empty scalars, union arrays. Returns a new object. */
export function mergeRecords(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) out[k] = uniq([...(out[k] || []), ...v]);
    else if (out[k] == null || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) out[k] = v;
  }
  return out;
}

/** Final pass producing the schema documented at the top of this file. */
export function finalizeRecord(r, knownCities = []) {
  const { styles, amenities } = splitAmenities([...(r.styles || []), ...(r.amenities || [])]);
  const types = uniq(r.types);
  const address = clean(r.address);
  const city = clean(r.city) || resolveCity(address, knownCities);
  const lat = r.lat == null ? null : Number(r.lat);
  const lng = r.lng == null ? null : Number(r.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    id: String(r.id ?? r.slug ?? r.url),
    slug: clean(r.slug),
    url: r.url || '',
    name: clean(r.name) || clean(r.slug) || 'ללא שם',
    address,
    city,
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    geo: hasCoords ? r.geo || 'site' : null,
    types,
    styles,
    amenities,
    plans: normalizePlans(r.plans),
    group: groupFor(types, styles),
    hours: uniq(r.hours),
    notes: (r.notes || '').trim(),
    description: (r.description || '').trim(),
    image: r.image || '',
  };
}

/** Light version for the list endpoint (keeps payloads small). */
export function toListItem(r) {
  const { notes, description, hours, ...rest } = r;
  return rest;
}

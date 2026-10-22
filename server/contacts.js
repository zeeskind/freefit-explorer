/**
 * Public contact extraction for business pages.
 *
 * WhatsApp policy: a number is only marked WhatsApp when the source itself says so:
 *   evidence 'link'  → a wa.me / api.whatsapp.com / whatsapp:// link
 *   evidence 'label' → the number appears right next to a WhatsApp label in the text
 * Plain phone numbers are never treated as WhatsApp. (There is no legitimate public way
 * to check whether an arbitrary number has a WhatsApp account.)
 *
 * Contact shape:
 * {
 *   phones:   [{ e164, display, source, sourceUrl }],
 *   whatsapp: [{ e164, display, url, evidence: 'link'|'label', source, sourceUrl }],
 *   emails:   [{ email, source, sourceUrl }],
 *   websites: [{ url, kind: 'website'|'links'|'booking', source }],
 *   social:   { instagram?, facebook?, tiktok?, youtube?, linkedin?, x? },
 * }
 */

/* ------------------------------ phones ------------------------------- */

// 0 + area/prefix + 7 digits, optional separators; or +972 without the 0.
const PHONE_RE = /(?<![\d+])(?:\+972[\s.-]?|972[\s.-]?|0)(?:[23489]|5\d|7\d)(?:[\s.-]?\d){7}(?!\d)/g;

/** Normalize an Israeli phone number. Returns { e164, display } or null. */
export function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00972')) d = d.slice(5);
  else if (d.startsWith('972')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  else return null;
  if (d.startsWith('0')) d = d.slice(1); // "+972 (0)50…"
  // Mobile 5X / VoIP 7X: 9 digits; landline 2,3,4,8,9: 8 digits.
  const mobile = /^[57]\d{8}$/.test(d);
  const land = /^[23489]\d{7}$/.test(d);
  if (!mobile && !land) return null;
  const local = `0${d}`;
  const display = mobile ? `${local.slice(0, 3)}-${local.slice(3)}` : `${local.slice(0, 2)}-${local.slice(2)}`;
  return { e164: `+972${d}`, display };
}

export function findPhones(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PHONE_RE)) {
    const p = normalizePhone(m[0]);
    if (p) out.push({ ...p, index: m.index, length: m[0].length });
  }
  return out;
}

/* ----------------------------- WhatsApp ------------------------------ */

const WA_LABEL = /whats\s?app|וואטסאפ|ווטסאפ|וואצאפ|ווצאפ|וואטצאפ|ווטצאפ|וטסאפ|וואטסאפּ/gi;
const NEGATION = /(לא|אין|ללא|not|no)\s*(זמינ\S*\s*)?(ב|ל)?$/i;

/**
 * Phone numbers that the text explicitly labels as WhatsApp.
 * A label belongs to the number right after it ("וואטסאפ: 050…"); only when no number
 * follows does it attach to a number right before it ("050… (וואטסאפ)").
 */
export function findLabeledWhatsapp(text) {
  const s = String(text || '');
  const phones = findPhones(s);
  const hits = new Map();
  const sameSentence = (between) => !/[!?\n]|\.\s/.test(between);
  for (const m of s.matchAll(WA_LABEL)) {
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (NEGATION.test(before)) continue;
    const labelEnd = m.index + m[0].length;
    const next = phones.find((p) => p.index >= labelEnd && p.index - labelEnd <= 40 && sameSentence(s.slice(labelEnd, p.index)));
    if (next) {
      hits.set(next.e164, next);
      continue;
    }
    const prev = [...phones].reverse().find((p) => p.index + p.length <= m.index && m.index - (p.index + p.length) <= 6 && sameSentence(s.slice(p.index + p.length, m.index)));
    if (prev) hits.set(prev.e164, prev);
  }
  return [...hits.values()];
}

/** Parse a WhatsApp link. Returns { e164, display, url } or { group: url } or null. */
export function parseWhatsappUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  let num = null;
  if (u.protocol === 'whatsapp:') num = u.searchParams.get('phone');
  else if (host === 'wa.me') num = u.pathname.replace(/\//g, '');
  else if (host === 'api.whatsapp.com' || host === 'web.whatsapp.com') num = u.searchParams.get('phone');
  else if (host === 'chat.whatsapp.com') return { group: u.toString() };
  else return null;
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  const p = normalizePhone(digits.startsWith('972') ? `+${digits}` : digits.startsWith('0') ? digits : `+${digits}`);
  return p ? { ...p, url: `https://wa.me/${p.e164.slice(1)}` } : null;
}

/* ------------------------------- URLs -------------------------------- */

const SOCIAL = {
  instagram: /(^|\.)instagram\.com$/,
  facebook: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/,
  tiktok: /(^|\.)tiktok\.com$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/,
  linkedin: /(^|\.)linkedin\.com$/,
  x: /(^|\.)(twitter\.com|x\.com)$/,
};
const IGNORE_HOSTS = [
  /(^|\.)freefit\.co\.il$/,
  /^ffapp\.page\.link$/,
  /(^|\.)apps\.apple\.com$/,
  /(^|\.)play\.google\.com$/,
  /(^|\.)google\.[a-z.]+$/,
  /^maps\.app\.goo\.gl$/,
  /^goo\.gl$/,
  /(^|\.)waze\.com$/,
  /(^|\.)intellinet\.co\.il$/,
  /(^|\.)wordpress\.org$/,
  /(^|\.)elementor\.com$/,
  /(^|\.)w3\.org$/,
  /(^|\.)schema\.org$/,
  /(^|\.)gravatar\.com$/,
  /(^|\.)(cloudflare|jsdelivr|googleapis|gstatic|cdnjs)\.[a-z.]+$/,
];
const BOOKING = /(^|\.)(arboxapp\.com|arbox\.co\.il|boostapp\.co\.il|boostapp\.io|mindbodyonline\.com|mindbody\.io|glofox\.com|fitstudio\.co\.il)$/;
const LINKS_PAGE = /(^|\.)(linktr\.ee|linkin\.bio|beacons\.ai|lnk\.bio|bio\.link|taplink\.cc)$/;

/** Classify a URL. `ownHosts` are hosts that belong to the page being parsed. */
export function classifyUrl(href, { ownHosts = [] } = {}) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === 'tel:') return 'tel';
  if (u.protocol === 'mailto:') return 'mailto';
  if (u.protocol === 'whatsapp:') return 'whatsapp';
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/^(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)$/.test(host)) return 'whatsapp';
  for (const [k, re] of Object.entries(SOCIAL)) if (re.test(host)) return k;
  if (IGNORE_HOSTS.some((re) => re.test(host))) return null;
  if (ownHosts.some((h) => h.replace(/^www\./, '') === host)) return null;
  if (BOOKING.test(host)) return 'booking';
  if (LINKS_PAGE.test(host)) return 'links';
  if (/\.(jpe?g|png|gif|webp|svg|pdf|mp4|css|js)(\?|$)/i.test(u.pathname)) return null;
  return 'website';
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;
const BARE_DOMAIN_IN_TEXT = /(?<![@\w./-])(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"']*)?/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Normalize a social profile URL to a clean canonical form. */
function cleanSocial(u) {
  try {
    const x = new URL(u);
    x.search = '';
    x.hash = '';
    return x.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

export function emptyContact() {
  return { phones: [], whatsapp: [], emails: [], websites: [], social: {} };
}

/**
 * Extract contacts from a set of links and a block of visible text.
 * links: [{ href, text }]; text: visible text (no URLs from attributes).
 */
export function extractContacts({ links = [], text = '', source, sourceUrl, ownHosts = [] }) {
  const c = emptyContact();
  const addPhone = (p) => {
    if (p && !c.phones.some((x) => x.e164 === p.e164)) c.phones.push({ e164: p.e164, display: p.display, source, sourceUrl });
  };
  const addWa = (p, evidence) => {
    if (!p) return;
    const existing = c.whatsapp.find((x) => x.e164 === p.e164);
    if (existing) {
      if (evidence === 'link') existing.evidence = 'link';
      return;
    }
    c.whatsapp.push({ e164: p.e164, display: p.display, url: `https://wa.me/${p.e164.slice(1)}`, evidence, source, sourceUrl });
  };
  const addEmail = (e) => {
    const email = e.toLowerCase().replace(/^mailto:/, '').split('?')[0].trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return;
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(email) || /@(sentry|example|domain|wixpress)\./.test(email)) return;
    if (/@freefit\.co\.il$/.test(email)) return;
    if (!c.emails.some((x) => x.email === email)) c.emails.push({ email, source, sourceUrl });
  };
  const addSite = (url, kind) => {
    if (!c.websites.some((w) => w.url === url)) c.websites.push({ url, kind, source });
  };

  const allLinks = [...links];
  for (const m of String(text).matchAll(URL_IN_TEXT)) allLinks.push({ href: m[0], text: '' });
  for (const m of String(text).matchAll(BARE_DOMAIN_IN_TEXT)) allLinks.push({ href: `https://${m[0]}`, text: '' });

  for (const { href, text: label } of allLinks) {
    if (!href) continue;
    const kind = classifyUrl(href, { ownHosts });
    if (!kind) continue;
    if (kind === 'tel') {
      const p = normalizePhone(decodeURIComponent(href.slice(4)));
      // A tel: link explicitly labelled WhatsApp counts as label evidence.
      if (p && WA_LABEL.test(label || '')) addWa(p, 'label');
      WA_LABEL.lastIndex = 0;
      addPhone(p);
    } else if (kind === 'mailto') addEmail(href);
    else if (kind === 'whatsapp') {
      const w = parseWhatsappUrl(href);
      if (w?.e164) addWa(w, 'link');
    } else if (SOCIAL[kind]) {
      if (!c.social[kind]) c.social[kind] = cleanSocial(href);
    } else addSite(href.split('#')[0], kind);
  }

  for (const p of findLabeledWhatsapp(text)) addWa(p, 'label');
  for (const p of findPhones(text)) addPhone(p);
  for (const m of String(text).matchAll(EMAIL_RE)) addEmail(m[0]);
  return c;
}

/** Merge contact b into a (a's entries keep priority). */
export function mergeContacts(a, b) {
  const out = a ? structuredClone(a) : emptyContact();
  if (!b) return out;
  for (const p of b.phones || []) if (!out.phones.some((x) => x.e164 === p.e164)) out.phones.push(p);
  for (const w of b.whatsapp || []) {
    const ex = out.whatsapp.find((x) => x.e164 === w.e164);
    if (!ex) out.whatsapp.push(w);
    else if (w.evidence === 'link' && ex.evidence !== 'link') Object.assign(ex, { evidence: 'link', source: w.source, sourceUrl: w.sourceUrl });
  }
  for (const e of b.emails || []) if (!out.emails.some((x) => x.email === e.email)) out.emails.push(e);
  for (const w of b.websites || []) if (!out.websites.some((x) => x.url === w.url)) out.websites.push(w);
  for (const [k, v] of Object.entries(b.social || {})) if (!out.social[k]) out.social[k] = v;
  return out;
}

/** The main site to show: a real website first, then a links page, then booking. */
export function primaryWebsite(c) {
  for (const kind of ['website', 'links', 'booking']) {
    const w = c?.websites?.find((x) => x.kind === kind);
    if (w) return w;
  }
  return null;
}

/**
 * Remove contacts that appear on a large share of Freefit pages: those belong to the
 * Freefit site itself (floating chat buttons, footers), not to the business.
 */
export function stripSiteWide(records, { minPages = 20, share = 0.12 } = {}) {
  const withContact = records.filter((r) => r.contact);
  if (withContact.length < minPages) return { records, removed: [] };
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const r of withContact) {
    const keys = new Set([
      ...r.contact.phones.map((p) => `p:${p.e164}`),
      ...r.contact.whatsapp.map((p) => `p:${p.e164}`),
      ...r.contact.emails.map((e) => `e:${e.email}`),
      ...r.contact.websites.map((w) => `w:${w.url}`),
      ...Object.values(r.contact.social).map((s) => `s:${s}`),
    ]);
    keys.forEach(bump);
  }
  const limit = Math.max(5, Math.ceil(withContact.length * share));
  const banned = new Set([...counts].filter(([, n]) => n > limit).map(([k]) => k));
  if (!banned.size) return { records, removed: [] };
  const out = records.map((r) => {
    if (!r.contact) return r;
    const c = r.contact;
    return {
      ...r,
      contact: {
        phones: c.phones.filter((p) => !banned.has(`p:${p.e164}`)),
        whatsapp: c.whatsapp.filter((p) => !banned.has(`p:${p.e164}`)),
        emails: c.emails.filter((e) => !banned.has(`e:${e.email}`)),
        websites: c.websites.filter((w) => !banned.has(`w:${w.url}`)),
        social: Object.fromEntries(Object.entries(c.social).filter(([, v]) => !banned.has(`s:${v}`))),
      },
    };
  });
  return { records: out, removed: [...banned] };
}

/** Kinds of contact available, for list badges and filtering. */
export function contactKinds(c) {
  if (!c) return [];
  const k = [];
  if (c.whatsapp?.length) k.push('whatsapp');
  if (c.phones?.length) k.push('phone');
  if (c.emails?.length) k.push('email');
  if (primaryWebsite(c)) k.push('website');
  if (Object.keys(c.social || {}).length) k.push('social');
  return k;
}

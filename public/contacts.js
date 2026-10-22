// Pure helpers that turn a location's contact data into safe UI actions.
// No DOM here: imported by app.js and by the Node tests.

/** Return the URL only if it uses an allowed protocol (blocks javascript:, data:, …). */
export function safeUrl(u, protocols = ['http:', 'https:']) {
  try {
    const x = new URL(u);
    return protocols.includes(x.protocol) ? x.toString() : null;
  } catch {
    return null;
  }
}

const E164 = /^\+972\d{8,9}$/;
const EMAIL = /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i;

export const EVIDENCE_TEXT = {
  link: 'העסק פרסם קישור וואטסאפ למספר הזה',
  label: 'העסק פרסם את המספר הזה כמספר וואטסאפ',
  osm: 'המספר רשום כוואטסאפ של העסק ב-OpenStreetMap',
  manual: 'הוזן ידנית כמספר הוואטסאפ של העסק',
};
export const SOURCE_TEXT = { freefit: 'דף העסק ב-Freefit', site: 'אתר העסק', osm: 'OpenStreetMap', manual: 'קובץ ההוספות הידניות' };

/**
 * Contact actions, WhatsApp first. WhatsApp entries exist only where the business
 * itself published the number as WhatsApp; plain phones never become WhatsApp.
 */
export function contactActions(item) {
  const c = item?.contact || {};
  const out = [];
  for (const w of c.whatsapp || []) {
    if (!E164.test(w.e164)) continue;
    out.push({
      kind: 'whatsapp',
      href: `https://wa.me/${w.e164.slice(1)}`,
      label: 'WhatsApp',
      value: w.display,
      copy: w.display,
      evidence: EVIDENCE_TEXT[w.evidence] || '',
      source: SOURCE_TEXT[w.source] || '',
      sourceUrl: safeUrl(w.sourceUrl),
    });
  }
  for (const p of c.phones || []) {
    if (!E164.test(p.e164) && !/^\*\d{4}$/.test(p.e164)) continue;
    out.push({ kind: 'phone', href: `tel:${encodeURIComponent(p.e164)}`, label: 'חיוג', value: p.display, copy: p.display, source: SOURCE_TEXT[p.source] || '', sourceUrl: safeUrl(p.sourceUrl) });
  }
  for (const e of c.emails || []) {
    if (!EMAIL.test(e.email)) continue;
    out.push({ kind: 'email', href: `mailto:${e.email}`, label: 'מייל', value: e.email, copy: e.email, source: SOURCE_TEXT[e.source] || '', sourceUrl: safeUrl(e.sourceUrl) });
  }
  return out;
}

const KIND_LABEL = { website: 'אתר העסק', links: 'דף הקישורים של העסק', booking: 'הזמנת שיעור' };

/** The business's own site (website → links page → booking page), or null. */
export function websiteInfo(item) {
  const list = item?.contact?.websites || [];
  for (const kind of ['website', 'links', 'booking']) {
    const w = list.find((x) => x.kind === kind && safeUrl(x.url));
    if (w) {
      const url = safeUrl(w.url);
      return { url, kind, label: KIND_LABEL[kind], host: new URL(url).hostname.replace(/^www\./, '') };
    }
  }
  return null;
}

/** Booking link, if the business uses an online booking system. */
export function bookingInfo(item) {
  const w = (item?.contact?.websites || []).find((x) => x.kind === 'booking' && safeUrl(x.url));
  return w ? { url: safeUrl(w.url), label: KIND_LABEL.booking } : null;
}

const SOCIAL_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', x: 'X' };

export function socialLinks(item) {
  return Object.entries(item?.contact?.social || {})
    .map(([k, url]) => ({ kind: k, label: SOCIAL_LABEL[k] || k, url: safeUrl(url) }))
    .filter((s) => s.url);
}

/** Search link used when no website was found. */
export function searchUrl(item) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${item?.name || ''} ${item?.city || ''}`.trim())}`;
}

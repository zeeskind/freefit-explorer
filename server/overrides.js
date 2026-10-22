/**
 * data/overrides.json lets you add what automatic sources can't find:
 *
 * {
 *   "ספורטן פתח תקווה": { "website": "https://www.sportan.org.il/" },
 *   "https://website.freefit.co.il/club/…/": { "whatsapp": "052-6996306", "phone": "*6669" }
 * }
 *
 * Keys: the Freefit page URL, the Freefit id, the exact name, or a piece of the name that
 * matches exactly one business. Values: website, whatsapp, phone, email, instagram, facebook
 * (a string or a list). Websites listed here are visited like any other business site.
 */
import fs from 'node:fs/promises';
import { emptyContact, normalizePhone, classifyUrl } from './contacts.js';

export async function loadOverrides(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`data/overrides.json is not valid JSON: ${e.message}`);
  }
}

const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Map each override key to one record. Returns { matches: Map(recordKey → entry), unmatched: [] }. */
export function matchOverrides(overrides, records) {
  const matches = new Map();
  const unmatched = [];
  for (const [key, entry] of Object.entries(overrides)) {
    if (key.startsWith('_')) continue; // comments
    const k = norm(key);
    let hits = records.filter((r) => norm(r.url) === k || norm(r.url).replace(/\/$/, '') === k.replace(/\/$/, '') || String(r.id) === key || norm(r.name) === k);
    if (!hits.length) hits = records.filter((r) => norm(r.name).includes(k));
    if (hits.length === 1) matches.set(hits[0].url || String(hits[0].id), entry);
    else unmatched.push({ key, reason: hits.length ? `${hits.length} businesses match` : 'no business matches' });
  }
  return { matches, unmatched };
}

/** Contact object from one override entry (source "manual"). */
export function overrideContact(entry) {
  const c = emptyContact();
  for (const raw of list(entry.phone)) {
    const p = /^\*?\d{4}\*?$/.test(raw.trim()) ? { e164: `*${raw.replace(/\D/g, '')}`, display: `*${raw.replace(/\D/g, '')}` } : normalizePhone(raw);
    if (p) c.phones.push({ ...p, source: 'manual' });
  }
  for (const raw of list(entry.whatsapp)) {
    const p = normalizePhone(raw.replace(/^https?:\/\/wa\.me\//, '+'));
    if (p) c.whatsapp.push({ ...p, url: `https://wa.me/${p.e164.slice(1)}`, evidence: 'manual', source: 'manual' });
  }
  for (const raw of list(entry.email)) if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(raw)) c.emails.push({ email: raw.toLowerCase(), source: 'manual' });
  for (const raw of list(entry.website)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const kind = classifyUrl(url) || 'website';
    if (['website', 'links', 'booking'].includes(kind)) c.websites.push({ url, kind, source: 'manual' });
  }
  for (const k of ['instagram', 'facebook']) if (entry[k]) c.social[k] = String(entry[k]);
  return c;
}

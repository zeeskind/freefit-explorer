import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './http.js';
import { inIsrael } from './config.js';

/**
 * Geocoder with a JSON cache on disk. Cache hits are instant; misses are throttled
 * to respect Nominatim's usage policy (max 1 request per second, identifying UA).
 */
export class Geocoder {
  constructor({ endpoint, userAgent, minIntervalMs, cacheFile, enabled = true }) {
    Object.assign(this, { endpoint, userAgent, minIntervalMs, cacheFile, enabled });
    this.cache = new Map();
    this.lastCall = 0;
    this.dirty = 0;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      this.cache = new Map(Object.entries(raw));
    } catch {
      this.cache = new Map();
    }
    return this;
  }

  async save() {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.cache)));
    await fs.rename(tmp, this.cacheFile);
    this.dirty = 0;
  }

  key(q) {
    return q.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  has(q) {
    return this.cache.has(this.key(q));
  }

  /** Returns { lat, lng } or null. Never throws. */
  async lookup(query) {
    const k = this.key(query);
    if (!k) return null;
    if (this.cache.has(k)) return this.cache.get(k);
    if (!this.enabled) return null;

    const wait = this.lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();

    const url = new URL(this.endpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'il');
    url.searchParams.set('accept-language', 'he');
    url.searchParams.set('q', query);

    let result = null;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        // Back off and do not cache a transient failure.
        await sleep(5000);
        return null;
      }
      const list = res.ok ? await res.json() : [];
      const hit = Array.isArray(list) ? list[0] : null;
      if (hit) {
        const lat = parseFloat(hit.lat);
        const lng = parseFloat(hit.lon);
        if (inIsrael(lat, lng)) result = { lat, lng };
      }
    } catch {
      return null; // network problem: try again on a later run
    }
    this.cache.set(k, result);
    if (++this.dirty >= 20) await this.save();
    return result;
  }
}

/** Address variants to try, most specific first. */
export function addressQueries(address, city) {
  const out = [];
  const a = (address || '').replace(/\s+/g, ' ').trim();
  if (a) {
    out.push(/ישראל|israel/i.test(a) ? a : `${a}, ישראל`);
    // "Street 3, City" without extra descriptors such as floor or mall name.
    const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 2) out.push(`${parts[0]}, ${parts[parts.length - 1]}, ישראל`);
    if (city && !a.includes(city)) out.push(`${parts[0]}, ${city}, ישראל`);
  }
  return [...new Set(out)];
}

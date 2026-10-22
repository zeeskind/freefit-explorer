import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './http.js';
import { inIsrael, ISRAEL_BBOX } from './config.js';

/**
 * No-key geocoding with a disk cache:
 *   1. Nominatim (OpenStreetMap) — max 1 request/second, identifying User-Agent.
 *   2. Photon (komoot, also OpenStreetMap data) — used when Nominatim has no match,
 *      or after Nominatim keeps refusing requests (common from cloud/CI machines).
 * Only definite answers are cached; network errors and rate limits are retried next run.
 */
export class Geocoder {
  constructor({ endpoint, fallbackEndpoint, userAgent, minIntervalMs, cacheFile, enabled = true }) {
    Object.assign(this, { userAgent, minIntervalMs, cacheFile, enabled });
    this.providers = [
      endpoint && { name: 'nominatim', url: endpoint, last: 0, strikes: 0, disabled: false },
      fallbackEndpoint && fallbackEndpoint !== 'off' && { name: 'photon', url: fallbackEndpoint, last: 0, strikes: 0, disabled: false },
    ].filter(Boolean);
    this.cache = new Map();
    this.dirty = 0;
    this.stats = { cacheHits: 0, found: 0, notFound: 0, transient: 0, reasons: {} };
  }

  async load() {
    try {
      this.cache = new Map(Object.entries(JSON.parse(await fs.readFile(this.cacheFile, 'utf8'))));
    } catch {
      this.cache = new Map();
    }
    return this;
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = 0;
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(`${this.cacheFile}.tmp`, JSON.stringify(Object.fromEntries(this.cache)));
    await fs.rename(`${this.cacheFile}.tmp`, this.cacheFile);
  }

  key(q) {
    return q.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  has(q) {
    return this.cache.has(this.key(q));
  }

  summary() {
    const s = this.stats;
    const reasons = Object.entries(s.reasons).map(([k, v]) => `${k}×${v}`).join(', ');
    const off = this.providers.filter((p) => p.disabled).map((p) => p.name);
    return `geocoding: ${s.found} found, ${s.notFound} not found, ${s.cacheHits} from cache, ${s.transient} failed${reasons ? ` (${reasons})` : ''}${off.length ? `; stopped using ${off.join(', ')} after repeated refusals` : ''}`;
  }

  /** Returns { lat, lng } or null. Never throws. */
  async lookup(query) {
    const k = this.key(query);
    if (!k) return null;
    if (this.cache.has(k)) {
      this.stats.cacheHits++;
      return this.cache.get(k);
    }
    if (!this.enabled) return null;

    let definiteMiss = false;
    for (const p of this.providers) {
      if (p.disabled) continue;
      const r = await this.#ask(p, query);
      if (r.found) {
        p.strikes = 0;
        this.#store(k, r.found);
        this.stats.found++;
        return r.found;
      }
      if (r.miss) {
        p.strikes = 0;
        definiteMiss = true;
        continue; // the next provider may know the address
      }
      const why = `${p.name} ${r.reason}`;
      this.stats.reasons[why] = (this.stats.reasons[why] || 0) + 1;
      if (++p.strikes >= 5) p.disabled = true; // keeps refusing: stop asking this run
    }
    if (definiteMiss) {
      this.#store(k, null);
      this.stats.notFound++;
    } else this.stats.transient++;
    return null;
  }

  #store(k, v) {
    this.cache.set(k, v);
    if (++this.dirty >= 20) this.save().catch(() => {});
  }

  async #ask(p, query) {
    const wait = p.last + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    p.last = Date.now();

    const url = new URL(p.url);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '1');
    if (p.name === 'photon') {
      url.searchParams.set('bbox', `${ISRAEL_BBOX.west},${ISRAEL_BBOX.south},${ISRAEL_BBOX.east},${ISRAEL_BBOX.north}`);
    } else {
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('countrycodes', 'il');
      url.searchParams.set('accept-language', 'he');
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 429) await sleep(3000);
        return { reason: `HTTP ${res.status}` };
      }
      const body = await res.json();
      let lat;
      let lng;
      if (p.name === 'photon') {
        [lng, lat] = body?.features?.[0]?.geometry?.coordinates || [];
      } else {
        const hit = Array.isArray(body) ? body[0] : null;
        lat = parseFloat(hit?.lat);
        lng = parseFloat(hit?.lon);
      }
      return inIsrael(lat, lng) ? { found: { lat, lng } } : { miss: true };
    } catch (e) {
      return { reason: e.name === 'TimeoutError' ? 'timeout' : 'network error' };
    }
  }
}

/** Address variants to try, most specific first. */
export function addressQueries(address, city) {
  const out = [];
  const a = (address || '').replace(/\s+/g, ' ').trim();
  if (a) {
    out.push(/ישראל|israel/i.test(a) ? a : `${a}, ישראל`);
    const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 2) out.push(`${parts[0]}, ${parts[parts.length - 1]}, ישראל`);
    if (city && !a.includes(city)) out.push(`${parts[0]}, ${city}, ישראל`);
  }
  return [...new Set(out)];
}

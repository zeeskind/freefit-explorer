import fs from 'node:fs/promises';
import path from 'node:path';
import { request } from './http.js';
import { loadFromWpRest } from './sources/wpRest.js';
import { parseLocationsFilters, discoverClubUrls, crawlMemberships, scrapeClubPages, wpSlugify } from './sources/html.js';
import { finalizeRecord, mergeRecords, slugFromUrl, safeDecode, toListItem, resolveCity, GROUPS, OTHER_GROUP, PLAN_ORDER } from './normalize.js';
import { stripSiteWide, mergeContacts, primaryWebsite, contactKinds, keepOwnBranch } from './contacts.js';
import { loadOsmVenues, indexVenues, matchVenue, venueContact, nameTokens } from './sources/osm.js';
import { SiteCache, crawlSites } from './sources/sites.js';
import { loadOverrides, matchOverrides, overrideContact } from './overrides.js';
import { Geocoder, addressQueries } from './geocode.js';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

export class DataService {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'locations.json');
    this.dataset = null;
    this.building = null;
    this.geocoding = null;
    this.abortGeocode = false;
    this.status = { state: 'idle', phase: null, done: 0, total: 0, error: null, log: [] };
    this.geocoder = new Geocoder({ ...cfg.geocode, cacheFile: path.join(cfg.dataDir, 'geocode-cache.json') });
    this.siteCache = new SiteCache(path.join(cfg.dataDir, 'sites-cache.json'), cfg.siteCacheDays ?? 14);
  }

  /* ----------------------------- lifecycle ----------------------------- */

  async init() {
    await fs.mkdir(this.cfg.dataDir, { recursive: true });
    await this.geocoder.load();
    try {
      this.dataset = JSON.parse(await fs.readFile(this.file, 'utf8'));
      log(`Loaded ${this.dataset.items.length} locations from cache (${this.dataset.generatedAt})`);
    } catch {
      log('No cached dataset yet');
    }
    const ageH = this.dataset ? (Date.now() - Date.parse(this.dataset.generatedAt)) / 36e5 : Infinity;
    if (!this.dataset || ageH > this.cfg.cacheTtlHours) this.refresh();
    else this.startGeocoding();
  }

  refresh() {
    if (this.building) return this.building;
    this.abortGeocode = true;
    this.building = this.#build()
      .catch((e) => {
        log('Build failed:', e);
        this.setStatus({ state: 'error', error: e.message });
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
  }

  note(msg) {
    log(msg);
    this.status.log = [...this.status.log.slice(-40), msg];
  }

  progress = ({ phase, done, total }) => this.setStatus({ phase, done, total });

  publicStatus() {
    const d = this.dataset;
    return {
      state: this.status.state,
      phase: this.status.phase,
      done: this.status.done,
      total: this.status.total,
      error: this.status.error,
      log: this.status.log.slice(-8),
      version: d?.version ?? null,
      generatedAt: d?.generatedAt ?? null,
      source: d?.source ?? null,
      count: d?.items.length ?? 0,
      located: d ? d.items.filter((i) => i.lat != null).length : 0,
      approximate: d ? d.items.filter((i) => i.geo === 'city').length : 0,
    };
  }

  /* ------------------------------- build ------------------------------- */

  async #build() {
    const { baseUrl, sourceMode } = this.cfg;
    this.setStatus({ state: 'building', phase: 'Reading the locations page', done: 0, total: 0, error: null, log: [] });
    this.note(`Building dataset from ${baseUrl} (mode: ${sourceMode})`);

    // Filter lists: canonical city / type / style / plan names.
    let filters = { city: [], types: [], styles: [], plans: [] };
    try {
      const { text } = await request(`${baseUrl}/locations/`);
      filters = parseLocationsFilters(text);
      this.note(`Filters: ${filters.city.length} cities, ${filters.types.length} types, ${filters.styles.length} styles, ${filters.plans.length} plans`);
    } catch (e) {
      this.note(`Could not read /locations/ (${e.message})`);
    }
    const knownCities = filters.city.map((o) => o.label);
    this.knownCities = knownCities;
    const termNames = {};
    for (const [role, tax] of [['types', 'club-type'], ['styles', 'club-activity']]) {
      for (const o of filters[role]) {
        for (const key of [safeDecode(o.value), wpSlugify(o.label)]) {
          termNames[`${tax}:${key}`] = o.label;
          termNames[key] = termNames[key] || o.label;
        }
      }
    }

    let records = [];
    let source = null;
    const want = (m) => sourceMode === 'auto' || sourceMode === m;

    // 1) WordPress REST API
    if (want('rest')) {
      try {
        this.setStatus({ phase: 'Trying the WordPress API' });
        const res = await loadFromWpRest(baseUrl, { log: (m) => this.note(m), onProgress: this.progress });
        if (res.records.length) {
          records = res.records;
          source = 'wp-rest';
        }
      } catch (e) {
        this.note(`REST unavailable: ${e.message}`);
      }
    }

    // 2) Sitemaps → club URLs
    if (!records.length && want('sitemap')) {
      this.setStatus({ phase: 'Reading sitemaps' });
      const urls = await discoverClubUrls(baseUrl, { log: (m) => this.note(m) });
      if (urls.length) {
        records = urls.map((url) => ({ url, slug: slugFromUrl(url) }));
        source = 'sitemap+html';
      }
    }

    // 3) Taxonomy archives → club URLs + type membership
    if (!records.length && want('archive') && filters.types.length) {
      this.setStatus({ phase: 'Crawling category pages' });
      const membership = await crawlMemberships(baseUrl, 'club-type', filters.types, {
        concurrency: this.cfg.scrapeConcurrency,
        onProgress: this.progress,
      });
      records = [...membership].map(([url, types]) => ({ url, slug: slugFromUrl(url), types }));
      if (records.length) source = 'archive+html';
      this.note(`Archives: ${records.length} clubs`);
    }

    if (!records.length) throw new Error('No data source worked. Run "npm run probe" to see what the site returned.');
    this.note(`Source: ${source}, ${records.length} clubs`);

    // Publish what we have so the UI is usable while pages are being read.
    this.#publish(records, source, knownCities);

    // Enrich from club pages where key details are missing.
    // Every club page is read: it is the source of public contact details.
    const needDetails = records.filter((r) => r.url && !r.contact);
    if (needDetails.length) {
      this.note(`Reading ${needDetails.length} club pages for details`);
      const pages = await scrapeClubPages(
        needDetails.map((r) => r.url),
        { concurrency: this.cfg.scrapeConcurrency, delayMs: this.cfg.requestDelayMs, termNames, onProgress: this.progress, log: (m) => this.note(m) }
      );
      const byUrl = new Map(pages.map((p) => [p.url, p]));
      records = records.map((r) => {
        const p = byUrl.get(r.url);
        if (!p) return r;
        // Prefer REST ids; the page gives everything else.
        const { id, ...rest } = p;
        return mergeRecords({ ...r, id: r.id ?? id }, rest);
      });
    }

    // Fill in categories from taxonomy archives when neither REST nor pages exposed them.
    for (const [field, tax, opts] of [['types', 'club-type', filters.types], ['styles', 'club-activity', filters.styles]]) {
      const covered = records.filter((r) => r[field]?.length).length;
      if (!opts.length || covered / records.length >= 0.5) continue;
      this.note(`Only ${covered}/${records.length} clubs have ${field}; reading ${tax} archives`);
      const membership = await crawlMemberships(baseUrl, tax, opts, { concurrency: this.cfg.scrapeConcurrency, onProgress: this.progress });
      records = records.map((r) => (membership.has(r.url) ? mergeRecords(r, { [field]: membership.get(r.url) }) : r));
    }

    // Contacts that repeat across many pages belong to Freefit itself, not the business.
    const stripped = stripSiteWide(records);
    records = stripped.records;
    if (stripped.removed.length) this.note(`Ignored site-wide contacts: ${stripped.removed.join(', ')}`);

    // Manual additions from data/overrides.json come first, so their websites are visited.
    try {
      const overrides = await loadOverrides(path.join(this.cfg.dataDir, 'overrides.json'));
      if (Object.keys(overrides).length) {
        const { matches, unmatched } = matchOverrides(overrides, records);
        records = records.map((r) => {
          const e = matches.get(r.url || String(r.id));
          return e ? { ...r, contact: mergeContacts(overrideContact(e), r.contact) } : r;
        });
        this.note(`overrides: applied ${matches.size} entr${matches.size === 1 ? 'y' : 'ies'}`);
        for (const u of unmatched) this.note(`overrides: "${u.key}" skipped (${u.reason})`);
      }
    } catch (e) {
      this.note(e.message);
    }

    // Visit each business's own website for more contact details.
    if (this.cfg.crawlSites !== false) records = await this.#enrichFromSites(records);

    this.#publish(records, source, knownCities);
    this.setStatus({ state: 'idle', phase: null, done: 0, total: 0 });
    this.note(`Done: ${this.dataset.items.length} locations`);
    this.startGeocoding();
  }

  async #enrichFromSites(records) {
    await this.siteCache.load();
    const targets = new Map();
    for (const r of records) {
      const w = primaryWebsite(r.contact);
      if (w && w.kind !== 'booking') targets.set(r.url, w.url);
    }
    if (!targets.size) return records;
    this.note(`Visiting ${new Set(targets.values()).size} business websites for contact details`);
    const results = await crawlSites([...targets.values()], {
      cache: this.siteCache,
      concurrency: this.cfg.siteConcurrency ?? 6,
      onProgress: this.progress,
      log: (m) => this.note(m),
    });
    await this.siteCache.save().catch((e) => this.note(`Could not save site cache: ${e.message}`));
    return records.map((r) => {
      const site = targets.get(r.url);
      if (!site) return r;
      const res = results.get(site);
      // Keep the link Freefit lists; drop numbers the site gives for other branches.
      const fromSite = res?.contact ? keepOwnBranch({ ...res.contact, websites: [] }, r.city || resolveCity(r.address, this.knownCities || []), this.knownCities || []) : null;
      return {
        ...r,
        contact: mergeContacts(r.contact, fromSite),
        siteStatus: { url: site, ok: !!res?.ok, finalUrl: res?.finalUrl || null, error: res?.ok ? null : res?.error || 'unreachable' },
      };
    });
  }

  #publish(records, source, knownCities) {
    const prev = new Map((this.dataset?.items || []).map((i) => [i.id, i]));
    const seen = new Set();
    const items = [];
    for (const r of records) {
      const item = finalizeRecord(r, knownCities);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      // Keep coordinates we already geocoded for an unchanged address.
      const old = prev.get(item.id);
      if (item.lat == null && old?.lat != null && old.address === item.address) {
        Object.assign(item, { lat: old.lat, lng: old.lng, geo: old.geo });
      }
      items.push(item);
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'he'));
    this.dataset = {
      version: Date.now(),
      generatedAt: new Date().toISOString(),
      source,
      knownCities,
      items,
    };
    this.#save();
  }

  /** Resolves when every pending write of locations.json has finished. */
  async flush() {
    while (this.savePromise) await this.savePromise;
  }

  #save() {
    if (this.saving) {
      this.saveAgain = true;
      return this.savePromise;
    }
    this.savePromise = this.#write().finally(() => {
      this.savePromise = null;
    });
    return this.savePromise;
  }

  async #write() {
    this.saving = true;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.dataset));
      await fs.rename(tmp, this.file);
    } catch (e) {
      log('Save failed:', e.message);
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        await this.#write();
      }
    }
  }

  #touch() {
    this.dataset = { ...this.dataset, version: Date.now() };
    this.#save();
  }

  /* ----------------------------- geocoding ----------------------------- */

  startGeocoding() {
    if (this.geocoding || !this.dataset) return;
    this.abortGeocode = false;
    this.geocoding = this.#geocodeAll()
      .catch((e) => log('Geocoding stopped:', e.message))
      .finally(async () => {
        await this.geocoder.save();
        this.geocoding = null;
        if (this.status.state === 'geocoding') this.setStatus({ state: 'idle', phase: null, done: 0, total: 0 });
      });
  }

  async #geocodeAll() {
    const items = () => this.dataset.items;

    // Pass 1: one lookup per city so every location gets an approximate pin fast.
    const cities = [...new Set(items().filter((i) => i.lat == null && i.city).map((i) => i.city))];
    const cityCoords = new Map();
    let n = 0;
    for (const city of cities) {
      if (this.abortGeocode) return;
      this.setStatus({ state: 'geocoding', phase: 'Placing cities on the map', done: n++, total: cities.length });
      const c = await this.geocoder.lookup(`${city}, ישראל`);
      if (c) cityCoords.set(city, c);
    }
    let changed = 0;
    for (const i of items()) {
      const c = i.lat == null && cityCoords.get(i.city);
      if (c) {
        Object.assign(i, { lat: c.lat, lng: c.lng, geo: 'city' });
        changed++;
      }
    }
    if (changed) this.#touch();

    // Pass 2: exact addresses (cache hits first, so a restart catches up instantly).
    const todo = items()
      .filter((i) => i.address && i.geo !== 'site' && i.geo !== 'exact')
      .sort((a, b) => Number(this.geocoder.has(addressQueries(b.address, b.city)[0] || '')) - Number(this.geocoder.has(addressQueries(a.address, a.city)[0] || '')));
    n = 0;
    changed = 0;
    for (const item of todo) {
      if (this.abortGeocode) return;
      this.setStatus({ state: 'geocoding', phase: 'Pinpointing addresses', done: n++, total: todo.length });
      for (const q of addressQueries(item.address, item.city)) {
        const c = await this.geocoder.lookup(q);
        if (!c) continue;
        // Sanity check: an exact pin should sit near its city.
        const city = cityCoords.get(item.city) || (item.geo === 'city' ? { lat: item.lat, lng: item.lng } : null);
        if (city && distanceKm(city, c) > 35) continue;
        Object.assign(item, { lat: c.lat, lng: c.lng, geo: 'exact' });
        changed++;
        break;
      }
      if (changed >= 25) {
        this.#touch();
        changed = 0;
      }
    }
    if (changed) this.#touch();
    this.note(this.geocoder.summary());
    this.note('Geocoding finished');
    await this.#enrichFromOsm();
  }

  /* ------------------------- OpenStreetMap ---------------------------- */

  async #enrichFromOsm() {
    const osm = this.cfg.osm;
    if (!osm?.enabled || !osm.endpoints?.length || this.abortGeocode) return;
    this.setStatus({ state: 'geocoding', phase: 'Matching places with OpenStreetMap', done: 0, total: 0 });
    let venues;
    try {
      venues = await loadOsmVenues({
        endpoints: osm.endpoints,
        cacheFile: path.join(this.cfg.dataDir, 'osm-cache.json'),
        ttlDays: osm.ttlDays ?? 7,
        userAgent: this.cfg.geocode?.userAgent || 'FreefitExplorer/1.0',
        log: (m) => this.note(m),
      });
    } catch (e) {
      this.note(`OpenStreetMap contacts unavailable this run: ${e.message}`);
      return;
    }
    if (this.abortGeocode) return;
    const items = this.dataset.items;
    const index = indexVenues(venues);
    // City names are not distinctive: "PURE חיפה" must not match every venue in Haifa.
    const extraGeneric = new Set((this.dataset.knownCities || []).flatMap((c) => nameTokens(c)));
    const sites = new Map();
    let matched = 0;
    let moved = 0;
    for (const [n, item] of items.entries()) {
      if (n % 50 === 0) this.setStatus({ done: n, total: items.length });
      const m = matchVenue(item, index, { extraGeneric });
      if (!m) continue;
      matched++;
      const c = venueContact(m.venue);
      item.contact = mergeContacts(item.contact, c);
      item.osm = { url: `https://www.openstreetmap.org/${m.venue.type}/${m.venue.id}`, name: m.venue.tags.name || m.venue.tags['name:he'] || '', distance: m.distance };
      if (item.geo === 'city') {
        Object.assign(item, { lat: m.venue.lat, lng: m.venue.lng, geo: 'osm' });
        moved++;
      }
      const w = primaryWebsite(c);
      if (w && w.kind !== 'booking' && !item.siteStatus) sites.set(item.id, w.url);
    }
    if (sites.size && this.cfg.crawlSites !== false) {
      await this.siteCache.load();
      const results = await crawlSites([...sites.values()], {
        cache: this.siteCache,
        concurrency: this.cfg.siteConcurrency ?? 6,
        onProgress: this.progress,
        log: (m) => this.note(m),
      });
      await this.siteCache.save().catch(() => {});
      for (const item of items) {
        const url = sites.get(item.id);
        if (!url) continue;
        const r = results.get(url);
        if (r?.contact) item.contact = mergeContacts(item.contact, keepOwnBranch({ ...r.contact, websites: [] }, item.city, this.dataset.knownCities || []));
        item.siteStatus = { url, ok: !!r?.ok, finalUrl: r?.finalUrl || null, error: r?.ok ? null : r?.error || 'unreachable' };
      }
    }
    for (const item of items) item.contactKinds = contactKinds(item.contact);
    const has = (k) => items.filter((i) => i.contactKinds.includes(k)).length;
    this.note(`osm: matched ${matched} of ${items.length} places (${moved} pins moved to the exact venue); now ${has('whatsapp')} with WhatsApp, ${has('phone')} with a phone, ${has('website')} with a website`);
    this.#touch();
  }

  /* ------------------------------- reads ------------------------------- */

  list() {
    if (!this.dataset) return null;
    const { version, generatedAt, source, items } = this.dataset;
    return {
      version,
      generatedAt,
      source,
      groups: [...GROUPS.map(({ kw, ...g }) => g), OTHER_GROUP],
      plans: PLAN_ORDER,
      items: items.map(toListItem),
    };
  }

  get(id) {
    return this.dataset?.items.find((i) => i.id === String(id)) || null;
  }
}

export function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

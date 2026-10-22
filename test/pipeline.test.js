import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock, makeClubs, expectedContacts } from './mockFreefit.js';
import { DataService } from '../server/dataService.js';
import { createApp } from '../server/index.js';

async function build(mode, n = 40, extra = {}) {
  const mock = await startMock({ mode, clubs: makeClubs(n) });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-'));
  const service = new DataService({
    baseUrl: mock.url,
    dataDir,
    sourceMode: 'auto',
    cacheTtlHours: 24,
    scrapeConcurrency: 6,
    requestDelayMs: 0,
    geocode: { enabled: true, endpoint: `${mock.url}/geocode`, minIntervalMs: 0, userAgent: 'test' },
    ...extra,
  });
  await service.geocoder.load();
  await service.refresh();
  await service.geocoding;
  return { mock, service, dataDir };
}

function assertDataset(service, n) {
  const items = service.dataset.items;
  assert.equal(items.length, n, 'every club present exactly once');
  const omada = items.find((i) => i.name.startsWith('אומדה'));
  assert.ok(omada, 'Hebrew-slug club present');
  assert.equal(omada.city, 'תל אביב');
  assert.deepEqual(omada.plans, ['SMART', 'PLUS', 'PRO', 'MAX']);
  assert.ok(omada.hours.length >= 3, 'hours scraped');
  for (const it of items) {
    assert.ok(it.address, `${it.name} has an address`);
    assert.ok(it.city, `${it.name} has a city`);
    assert.ok(it.types.length, `${it.name} has a type`);
    assert.ok(it.plans.length, `${it.name} has plans`);
    assert.ok(it.lat != null && it.lng != null, `${it.name} is on the map`);
    assert.notEqual(it.group, 'other', `${it.name} has a colour group`);
  }
  assert.ok(items.some((i) => i.amenities.includes('סאונה')), 'amenities split out of styles');
  assert.ok(!items.some((i) => i.styles.includes('סאונה')), 'amenities removed from styles');
  return items;
}

test('REST mode: API data + page enrichment + geocoding', async () => {
  const { mock, service, dataDir } = await build('rest');
  try {
    assert.equal(service.dataset.source, 'wp-rest');
    const items = assertDataset(service, 40);
    // Coordinates from ACF are kept as-is ("site"); the rest are geocoded ("exact").
    assert.equal(items.filter((i) => i.geo === 'site').length, 20);
    assert.equal(items.filter((i) => i.geo === 'exact').length, 20);
    assert.equal(items.find((i) => i.name.startsWith('אומדה')).name, 'אומדה – חדר כושר', 'entities decoded');
    // Persisted to disk.
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'locations.json'), 'utf8'));
    assert.equal(saved.items.length, 40);
  } finally {
    await mock.close();
  }
});

test('REST blocked: falls back to sitemap + page scraping', async () => {
  const { mock, service } = await build('norest');
  try {
    assert.equal(service.dataset.source, 'sitemap+html');
    assertDataset(service, 40);
  } finally {
    await mock.close();
  }
});

test('REST and sitemaps blocked: falls back to taxonomy archives', async () => {
  const { mock, service } = await build('archive');
  try {
    assert.equal(service.dataset.source, 'archive+html');
    const items = assertDataset(service, 40);
    // The footer link on every archive page must not inflate membership.
    const omada = items.find((i) => i.name.startsWith('אומדה'));
    assert.deepEqual(omada.types.sort(), ['אומנויות לחימה', 'חדר כושר'].sort());
  } finally {
    await mock.close();
  }
});

test('second run is served from the geocode cache (no new lookups)', async () => {
  const { mock, service, dataDir } = await build('norest', 24);
  try {
    const before = mock.stats.byPrefix.geocode || 0;
    const again = new DataService({ ...service.cfg, dataDir });
    await again.geocoder.load();
    await again.refresh();
    await again.geocoding;
    assert.equal(mock.stats.byPrefix.geocode || 0, before, 'no extra geocoder calls');
    assert.ok(again.dataset.items.every((i) => i.lat != null));
  } finally {
    await mock.close();
  }
});

test('HTTP API serves list, detail, status and ETag', async () => {
  const { mock, service } = await build('rest', 30);
  const app = createApp(service);
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.count, 30);
    assert.equal(status.located, 30);

    const res = await fetch(`${base}/api/locations`);
    const list = await res.json();
    assert.equal(list.items.length, 30);
    assert.ok(!('notes' in list.items[0]), 'list payload is light');
    assert.ok(!('contact' in list.items[0]), 'contacts only in details');
    assert.ok(Array.isArray(list.items[0].contactKinds));
    assert.ok(list.groups.length >= 7);

    const etag = res.headers.get('etag');
    const cached = await fetch(`${base}/api/locations`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);

    const detail = await (await fetch(`${base}/api/locations/${list.items[0].id}`)).json();
    assert.ok(detail.hours.length);
    assert.ok(detail.contact && Array.isArray(detail.contact.phones));
    assert.equal((await fetch(`${base}/api/locations/nope`)).status, 404);

    for (const asset of ['/', '/app.js', '/filter.js', '/contacts.js', '/styles.css', '/vendor/leaflet/leaflet.js', '/vendor/markercluster/leaflet.markercluster.js']) {
      assert.equal((await fetch(base + asset)).status, 200, asset);
    }
  } finally {
    server.close();
    await mock.close();
  }
});

test('contacts: each business gets its own public contacts, never Freefit\'s', async () => {
  const { mock, service } = await build('rest', 42);
  try {
    const items = service.dataset.items;
    const byId = new Map(items.map((i) => [i.id, i]));
    const freefitNumber = '+972559458809';
    for (const club of mock.clubs) {
      const it = byId.get(String(club.id));
      const exp = expectedContacts(club);
      const c = it.contact;
      const wa = c.whatsapp.map((w) => w.e164).sort();
      assert.deepEqual(wa, [...exp.whatsapp].sort(), `${it.name}: WhatsApp numbers`);
      for (const p of exp.phones) assert.ok(c.phones.some((x) => x.e164 === p), `${it.name}: phone ${p}`);
      if (exp.evidence === 'label' || exp.evidence === 'link') {
        if ((club.id - 29000) % 7 !== 3) assert.ok(c.whatsapp.every((w) => w.evidence === exp.evidence), `${it.name}: evidence ${exp.evidence}`);
      }
      // Freefit's own contacts (footer, floating button, "דברו איתנו") never reach a business.
      assert.ok(![...c.phones, ...c.whatsapp].some((x) => x.e164 === freefitNumber), `${it.name}: no Freefit number`);
      assert.ok(!c.emails.some((e) => e.email.endsWith('@freefit.co.il')), `${it.name}: no Freefit email`);
      assert.ok(!Object.values(c.social).some((u) => /facebook\.com\/Freefit/i.test(u)), `${it.name}: no Freefit social`);

      if (exp.website) {
        assert.equal(it.siteStatus.ok, true, `${it.name}: site crawled`);
        assert.ok(c.websites.some((w) => w.kind === 'website' && /\/biz\//.test(w.url)));
        assert.ok(c.emails.some((e) => e.email === exp.email), `${it.name}: email from the contact page`);
        assert.ok(c.whatsapp.find((w) => w.e164 === exp.whatsapp[0]).source === 'site');
        assert.equal(c.whatsapp.find((w) => w.e164 === exp.whatsapp[0]).evidence, 'link', 'floating wa link on the site');
        assert.equal(c.whatsapp.find((w) => w.e164 === exp.whatsapp[1]).evidence, 'label', '"WhatsApp 053…" on the contact page');
        assert.ok(!c.phones.some((p) => p.e164 === '+972500000000'), 'numbers inside <script> ignored');
      }
      if (exp.instagram) assert.match(c.social.instagram, /instagram\.com\/club\d+\.life/);
      if (exp.facebook) assert.match(c.social.facebook, /facebook\.com\/club\d+/);
      if (exp.websiteBlocked) {
        assert.equal(it.siteStatus.ok, false);
        assert.equal(it.siteStatus.error, 'blocked by robots.txt');
        assert.ok(!c.phones.some((p) => p.e164 === '+972501112222'), 'blocked site not read');
      }
      if (exp.websiteDead) assert.equal(it.siteStatus.ok, false);
      if (exp.booking) assert.ok(c.websites.some((w) => w.kind === 'booking'));
      assert.equal(it.contactKinds.includes('whatsapp'), exp.whatsapp.length > 0);
    }
    // Freefit's own number is excluded at extraction; the repeat-across-pages rule has its own unit test.
  } finally {
    await mock.close();
  }
});

test('business websites are cached between runs', async () => {
  const { mock, service, dataDir } = await build('norest', 21);
  try {
    const first = mock.stats.byPrefix.biz || 0;
    assert.ok(first > 0, 'sites were visited');
    const again = new DataService({ ...service.cfg, dataDir });
    await again.geocoder.load();
    await again.refresh();
    await again.geocoding;
    assert.equal(mock.stats.byPrefix.biz || 0, first, 'no new site requests');
    const biz = again.dataset.items.filter((i) => i.siteStatus?.ok);
    assert.ok(biz.length > 0 && biz.every((i) => i.contact.emails.length), 'cached contacts still applied');
  } finally {
    await mock.close();
  }
});

test('geocoding falls back to Photon when Nominatim refuses every request', async () => {
  const mock = await startMock({ mode: 'rest', clubs: makeClubs(12) });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-'));
  try {
    const service = new DataService({
      baseUrl: mock.url,
      dataDir,
      sourceMode: 'auto',
      cacheTtlHours: 24,
      scrapeConcurrency: 6,
      requestDelayMs: 0,
      crawlSites: false,
      geocode: { enabled: true, endpoint: `${mock.url}/geocode-blocked`, fallbackEndpoint: `${mock.url}/photon`, minIntervalMs: 0, userAgent: 'test' },
    });
    await service.geocoder.load();
    await service.refresh();
    await service.geocoding;
    assert.ok(service.dataset.items.every((i) => i.lat != null), 'every place on the map');
    const summary = service.geocoder.summary();
    assert.match(summary, /nominatim HTTP 429/);
    assert.match(summary, /stopped using nominatim/);
  } finally {
    await mock.close();
  }
});

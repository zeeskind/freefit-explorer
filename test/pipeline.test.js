import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock, makeClubs } from './mockFreefit.js';
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
    assert.ok(list.groups.length >= 7);

    const etag = res.headers.get('etag');
    const cached = await fetch(`${base}/api/locations`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);

    const detail = await (await fetch(`${base}/api/locations/${list.items[0].id}`)).json();
    assert.ok(detail.hours.length);
    assert.equal((await fetch(`${base}/api/locations/nope`)).status, 404);

    for (const asset of ['/', '/app.js', '/filter.js', '/styles.css', '/vendor/leaflet/leaflet.js', '/vendor/markercluster/leaflet.markercluster.js']) {
      assert.equal((await fetch(base + asset)).status, 200, asset);
    }
  } finally {
    server.close();
    await mock.close();
  }
});

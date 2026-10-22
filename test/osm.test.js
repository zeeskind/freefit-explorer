import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nameTokens, nameScore, matchVenue, indexVenues, venueContact } from '../server/sources/osm.js';
import { startMock, makeClubs, brandOf } from './mockFreefit.js';
import { DataService } from '../server/dataService.js';

const venue = (name, lat, lng, tags = {}, extra = {}) => ({ id: Math.floor(Math.random() * 1e9), type: 'node', lat, lng, tags: { name, ...tags }, ...extra });
const cities = new Set(['חיפה', 'תל', 'אביב', 'באר', 'יעקב']);

test('name tokens keep the distinctive words only', () => {
  assert.deepEqual(nameTokens('PURE פילאטיס מכשירים לנשים חנקין חיפה', cities), ['pure', 'חנקינ']);
  assert.deepEqual(nameTokens('Green box one פילאטיס מכשירים באר יעקב', cities), ['green', 'one']);
  assert.deepEqual(nameTokens('סטודיו לתנועה ובריאות'), ['בריאות']);
});

test('name score: shared words, Hebrew/English variants, no digit-prefix confusion', () => {
  assert.equal(nameScore('PURE פילאטיס מכשירים חיפה', venue('Pure Pilates', 0, 0), cities), 1);
  assert.equal(nameScore('אומדה', venue('Omada', 0, 0, { 'name:he': 'אומדה' })), 1);
  assert.equal(nameScore('Studio 1', venue('Studio 17', 0, 0)), 0);
  assert.equal(nameScore('Lotusfit1 פילאטיס', venue('Lotusfit17', 0, 0)), 0);
  assert.equal(nameScore('Holmes Place רמת גן', venue('Holmes Place', 0, 0)), 2);
  assert.equal(nameScore('חדר כושר עירוני', venue('Gym', 0, 0)), 0);
});

test('matching an exact pin: same name nearby yes, other business or far away no', () => {
  const item = { name: 'PURE פילאטיס מכשירים לנשים חנקין חיפה', lat: 32.794, lng: 34.9896, geo: 'exact' };
  const right = venue('PURE', 32.7944, 34.9896, { phone: '04-1234567' });
  const decoy = venue('Gold Gym', 32.7941, 34.9897);
  const far = venue('PURE', 32.81, 34.99);
  const m = matchVenue(item, indexVenues([decoy, far, right]), { extraGeneric: cities });
  assert.equal(m.venue, right);
  assert.ok(m.distance < 60);
  assert.equal(matchVenue(item, indexVenues([decoy, far]), { extraGeneric: cities }), null);
});

test('matching a city-level pin needs strong evidence, and refuses to guess', () => {
  const item = { name: 'Zenhaus7 פילאטיס מכשירים חיפה', lat: 32.794, lng: 34.9896, geo: 'city' };
  const one = venue('Zenhaus7 Studio', 32.812, 34.9896);
  assert.equal(matchVenue(item, indexVenues([one]), { extraGeneric: cities }).venue, one);
  const twin = venue('Zenhaus7', 32.77, 34.99);
  assert.equal(matchVenue(item, indexVenues([one, twin]), { extraGeneric: cities }), null, 'two candidates with one shared word');
  const shortName = { name: 'Box פילאטיס חיפה', lat: 32.794, lng: 34.9896, geo: 'city' };
  assert.equal(matchVenue(shortName, indexVenues([venue('Box', 32.8, 34.99)]), { extraGeneric: cities }), null, 'short common word in a whole city');
  const twoWords = { name: 'Holmes Place חיפה', lat: 32.794, lng: 34.9896, geo: 'city' };
  assert.ok(matchVenue(twoWords, indexVenues([venue('Holmes Place', 32.8, 34.99), venue('Holmes Place', 32.76, 34.99)]), { extraGeneric: cities }));
});

test('venue tags become contacts; only contact:whatsapp makes a WhatsApp entry', () => {
  const c = venueContact(venue('X', 32, 35, {
    phone: '+972 3 555 1234; 052-1112233',
    'contact:whatsapp': 'https://wa.me/972549998877',
    website: 'www.x-studio.co.il',
    'contact:instagram': '@xstudio',
    email: 'Hi@X-Studio.co.il',
  }));
  assert.deepEqual(c.phones.map((p) => p.e164), ['+97235551234', '+972521112233']);
  assert.deepEqual(c.whatsapp.map((w) => [w.e164, w.evidence]), [['+972549998877', 'osm']]);
  assert.equal(c.websites[0].url, 'https://www.x-studio.co.il');
  assert.equal(c.social.instagram, 'https://www.instagram.com/xstudio');
  assert.equal(c.emails[0].email, 'hi@x-studio.co.il');
  assert.ok(c.phones.every((p) => p.source === 'osm' && /openstreetmap\.org\/node\//.test(p.sourceUrl)));
});

async function realisticRun({ overpass = '/overpass', n = 28, overrides } = {}) {
  const mock = await startMock({ mode: 'norest', clubs: makeClubs(n, { bare: true, brand: true }) });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-osm-'));
  if (overrides) await fs.writeFile(path.join(dataDir, 'overrides.json'), JSON.stringify(overrides(mock)));
  const service = new DataService({
    baseUrl: mock.url,
    dataDir,
    sourceMode: 'auto',
    cacheTtlHours: 24,
    scrapeConcurrency: 6,
    requestDelayMs: 0,
    geocode: { enabled: true, endpoint: `${mock.url}/geocode-cityonly`, minIntervalMs: 0, userAgent: 'test' },
    osm: { enabled: true, endpoints: [`${mock.url}${overpass}`], ttlDays: 7 },
  });
  await service.geocoder.load();
  await service.refresh();
  await service.geocoding;
  return { mock, service, dataDir };
}

test('realistic run: bare Freefit pages, contacts come from OpenStreetMap', async () => {
  const { mock, service } = await realisticRun();
  try {
    const byId = new Map(service.dataset.items.map((i) => [i.id, i]));
    for (const club of mock.clubs) {
      const i = club.id - 29000;
      const it = byId.get(String(club.id));
      const c = it.contact;
      if (i % 4 === 0) {
        assert.ok(it.osm, `${it.name}: matched`);
        assert.ok(c.phones.some((p) => p.source === 'osm'), `${it.name}: phone from OSM`);
        assert.ok(c.whatsapp.some((w) => w.evidence === 'osm'), `${it.name}: WhatsApp from contact:whatsapp`);
        assert.equal(it.siteStatus?.ok, true, `${it.name}: website found on OSM was visited`);
        assert.ok(c.emails.length, `${it.name}: email from the website's contact page`);
        assert.ok(c.social.instagram, `${it.name}: instagram tag`);
        assert.ok(it.contactKinds.includes('whatsapp') && it.contactKinds.includes('website'));
      } else if (i % 4 === 1) {
        assert.ok(it.osm, `${it.name}: city-level pin matched by a distinctive name`);
        assert.equal(it.geo, 'osm', 'pin moved to the venue');
        assert.deepEqual(c.whatsapp, [], 'a phone tag alone is not WhatsApp');
        assert.equal(c.phones.length, 1);
      } else {
        assert.equal(it.osm, null, `${it.name}: ${i % 4 === 2 ? 'other business nearby' : 'ambiguous twins'} not matched`);
        assert.equal(c.phones.length + c.whatsapp.length, 0, `${it.name}: no borrowed contacts`);
      }
    }
    assert.ok(service.status.log.some((l) => /osm: matched 14 of 28/.test(l)), service.status.log.filter((l) => /osm/.test(l)).join(' | '));
  } finally {
    await mock.close();
  }
});

test('OpenStreetMap down: the run still completes, and the venue list is cached for next time', async () => {
  const down = await realisticRun({ overpass: '/overpass-down', n: 12 });
  try {
    assert.ok(down.service.dataset.items.length === 12);
    assert.ok(down.service.status.log.some((l) => /OpenStreetMap contacts unavailable/.test(l)));
  } finally {
    await down.mock.close();
  }
  const ok = await realisticRun({ n: 12 });
  try {
    const cache = JSON.parse(await fs.readFile(path.join(ok.dataDir, 'osm-cache.json'), 'utf8'));
    assert.ok(cache.venues.length > 0);
    assert.ok(ok.service.dataset.items.some((i) => i.osm));
  } finally {
    await ok.mock.close();
  }
});

test('manual overrides: a website you add is visited and its WhatsApp extracted', async () => {
  const { mock, service } = await realisticRun({
    n: 12,
    overrides: (m) => ({
      _comment: 'keys starting with _ are ignored',
      [brandOf(2)]: { website: `${m.url.replace('127.0.0.1', 'localhost')}/biz/2/`, phone: '*6669' },
      [brandOf(6)]: { whatsapp: '052-6996306' },
      'no such business': { website: 'https://example.co.il' },
    }),
  });
  try {
    const items = service.dataset.items;
    const two = items.find((i) => i.name.startsWith(brandOf(2)));
    assert.equal(two.siteStatus?.ok, true, 'the added website was visited');
    assert.ok(two.contact.whatsapp.some((w) => w.source === 'site' && w.evidence === 'link'), 'WhatsApp from the site');
    assert.ok(two.contact.phones.some((p) => p.e164 === '*6669' && p.source === 'manual'));
    assert.equal(two.contact.websites[0].source, 'manual');
    const six = items.find((i) => i.name.startsWith(brandOf(6)));
    assert.deepEqual(six.contact.whatsapp.map((w) => [w.e164, w.evidence]), [['+972526996306', 'manual']]);
    assert.ok(service.status.log.some((l) => /overrides: "no such business" skipped/.test(l)));
  } finally {
    await mock.close();
  }
});

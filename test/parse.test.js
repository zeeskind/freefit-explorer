import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClubPage, parseLocationsFilters, findCoordinates, decodeClassSlug } from '../server/sources/html.js';
import { finalizeRecord, resolveCity, splitAmenities, groupFor } from '../server/normalize.js';
import { scanFields, roleForTaxonomy } from '../server/sources/wpRest.js';
import { startMock } from './mockFreefit.js';

test('parses a club page with the real site structure', async () => {
  const mock = await startMock();
  try {
    const html = await (await fetch(`${mock.url}/club/${encodeURIComponent('אומדה')}/`)).text();
    const r = parseClubPage(html, `${mock.url}/club/x/`, { termNames: {} });
    assert.equal(r.name, 'אומדה');
    assert.equal(r.id, 29000);
    assert.equal(r.address, 'הרצל 3, תל אביב');
    assert.deepEqual(r.hours, ['ימים א׳-ה׳: 06:00-22:00', 'ימי שישי: 07:30-14:30', 'ימי שבת: 10:30-20:00']);
    assert.deepEqual(r.plans.map((p) => p.toUpperCase()), ['SMART', 'PLUS', 'PRO', 'MAX']);
    assert.match(r.notes, /ARBOX/);
    assert.match(r.description, /הסיבה שאנחנו/);
    assert.match(r.image, /image_small_29000/);
    assert.ok(r.types.includes('חדר כושר'), `types from sanitized post classes: ${r.types}`);
    assert.ok(r.styles.includes('פילאטיס מכשירים'), `styles: ${r.styles}`);
    assert.equal(r.lat, 32.0853); // from the embedded Google Maps iframe
  } finally {
    await mock.close();
  }
});

test('reads every filter list from the locations page', async () => {
  const mock = await startMock();
  try {
    const f = parseLocationsFilters(await (await fetch(`${mock.url}/locations/`)).text());
    assert.equal(f.city.length, 8);
    assert.equal(f.types.length, 7);
    assert.equal(f.styles.length, 10);
    assert.deepEqual(f.plans.map((p) => p.label), ['SMART', 'PLUS', 'PRO', 'MAX']);
    assert.ok(f.city.some((c) => c.label === 'הוד השרון'));
  } finally {
    await mock.close();
  }
});

test('decodes WordPress-sanitized Hebrew class slugs', () => {
  assert.equal(decodeClassSlug('d797d793d7a8-d79bd795d7a9d7a8'), 'חדר-כושר');
  assert.equal(decodeClassSlug('trx'), 'trx');
  assert.equal(decodeClassSlug('%d7%99%d7%95%d7%92%d7%94'), 'יוגה');
});

test('finds coordinates in common embed formats and rejects non-Israeli points', () => {
  assert.deepEqual(findCoordinates('<div data-lat="32.1" data-lng="34.9">'), { lat: 32.1, lng: 34.9 });
  assert.deepEqual(findCoordinates('{"lat":"31.25","lng":"34.79"}'), { lat: 31.25, lng: 34.79 });
  assert.deepEqual(findCoordinates('https://www.google.com/maps/place/x/@32.794,34.989,17z'), { lat: 32.794, lng: 34.989 });
  assert.deepEqual(findCoordinates('waze.com/ul?ll=32.0853%2C34.7818'), { lat: 32.0853, lng: 34.7818 });
  assert.equal(findCoordinates('data-lat="48.85" data-lng="2.35"'), null);
});

test('scans ACF fields for coordinates and address', () => {
  const f = scanFields({ acf: { address: 'הרצל 3, תל אביב', location: { lat: '32.08', lng: '34.78' } } });
  assert.equal(f.lat, 32.08);
  assert.equal(f.address, 'הרצל 3, תל אביב');
  assert.equal(roleForTaxonomy('club-type', 'סוגי מועדון'), 'types');
  assert.equal(roleForTaxonomy('club-activity', 'סגנון פעילות'), 'styles');
  assert.equal(roleForTaxonomy('route', 'מסלול'), 'plans');
  assert.equal(roleForTaxonomy('club-city', 'עיר'), 'city');
});

test('normalizes cities, amenities and colour groups', () => {
  assert.equal(resolveCity('סמטת הר גילה 3, הוד השרון', ['הוד השרון', 'השרון']), 'הוד השרון');
  assert.equal(resolveCity('דרך השלום 53, תל אביב-יפו', ['תל אביב']), 'תל אביב');
  assert.equal(resolveCity('ויצמן 10, כפר סבא', []), 'כפר סבא');
  assert.deepEqual(splitAmenities(['TRX', 'סאונה', 'חניה']), { styles: ['TRX'], amenities: ['סאונה', 'חניה'] });
  assert.equal(groupFor(['קרוספיט(R) ופונקציונלי']), 'functional');
  assert.equal(groupFor(['יוגה ופילאטיס']), 'studio');
  assert.equal(groupFor([], ['שחייה']), 'water');
  const r = finalizeRecord({ id: 1, name: ' x ', plans: ['max', 'smart', 'bogus'], styles: ['סאונה'] });
  assert.deepEqual(r.plans, ['SMART', 'MAX']);
  assert.deepEqual(r.amenities, ['סאונה']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, emptyFilters, indexItems, applyFilters, facetCounts, sortItems,
  filtersToParams, paramsToFilters, inBounds, activeFilterCount,
} from '../public/filter.js';

const items = () =>
  indexItems([
    { id: '1', name: 'אומדה', address: 'סמטת הר גילה 3, הוד השרון', city: 'הוד השרון', lat: 32.15, lng: 34.89, group: 'functional', types: ['קרוספיט(R) ופונקציונלי'], styles: ['פילאטיס מכשירים'], amenities: ['חניה'], plans: ['SMART', 'PLUS', 'PRO', 'MAX'] },
    { id: '2', name: 'Holmes Place', address: 'דרך השלום 53, תל אביב', city: 'תל אביב', lat: 32.07, lng: 34.79, group: 'gym', types: ['חדר כושר'], styles: ['ספינינג'], amenities: ['סאונה', 'חניה'], plans: ['PRO', 'MAX'] },
    { id: '3', name: 'בריכת גורדון', address: 'אליעזר פרי 14, תל אביב', city: 'תל אביב', lat: 32.08, lng: 34.77, group: 'water', types: ['בריכה'], styles: ['שחייה'], amenities: ['מקלחות', 'סאונה'], plans: ['MAX'] },
    { id: '4', name: 'סטודיו ים', address: 'הרצל 1, חיפה', city: 'חיפה', lat: null, lng: null, group: 'studio', types: ['יוגה ופילאטיס'], styles: ['יוגה'], amenities: [], plans: ['SMART', 'PLUS', 'PRO', 'MAX'] },
  ]);

test('normalizes Hebrew: finals, niqqud, punctuation', () => {
  assert.equal(normalizeText('שָׁלוֹם'), 'שלומ');
  assert.equal(normalizeText('ג\'קוזי, (סאונה)'), 'ג קוזי סאונה');
  assert.equal(normalizeText('Holmes-PLACE'), 'holmes place');
});

test('live text search: multi-token AND, final-letter insensitive, across fields', () => {
  const all = items();
  const q = (s) => applyFilters(all, { ...emptyFilters(), q: s }).map((i) => i.id);
  assert.deepEqual(q('תל אביב סאונה'), ['2', '3']);
  assert.deepEqual(q('holmes'), ['2']);
  assert.deepEqual(q('גורדונ'), ['3']); // typed with a regular nun
  assert.deepEqual(q('פילאטיס'), ['1', '4']);
  assert.deepEqual(q('zzz'), []);
});

test('facets: OR inside a facet, AND across facets, amenities require all', () => {
  const all = items();
  const f = emptyFilters();
  f.cities = new Set(['תל אביב', 'הוד השרון']);
  assert.equal(applyFilters(all, f).length, 3);
  f.plan = 'PRO';
  assert.deepEqual(applyFilters(all, f).map((i) => i.id), ['1', '2']);
  f.plan = '';
  f.amenities = new Set(['סאונה', 'חניה']);
  assert.deepEqual(applyFilters(all, f).map((i) => i.id), ['2']);
  f.amenities = new Set();
  f.groups = new Set(['water', 'gym']);
  assert.deepEqual(applyFilters(all, f).map((i) => i.id), ['2', '3']);
  assert.equal(activeFilterCount(f), 4);
});

test('facet counts ignore their own facet so options stay pickable', () => {
  const all = items();
  const f = emptyFilters();
  f.cities = new Set(['חיפה']);
  const cityCounts = facetCounts(all, f, 'cities');
  assert.equal(cityCounts.get('תל אביב'), 2, 'other cities still counted');
  const planCounts = facetCounts(all, f, 'plan');
  assert.equal(planCounts.get('MAX'), 1);
  assert.equal(planCounts.get('PRO'), 1);
  const groupCounts = facetCounts(all, { ...emptyFilters(), plan: 'MAX' }, 'groups');
  assert.equal(groupCounts.get('water'), 1);
});

test('map bounds and distance sorting', () => {
  const all = items();
  const telAviv = { south: 32.0, north: 32.1, west: 34.7, east: 34.85 };
  assert.deepEqual(all.filter((i) => inBounds(i, telAviv)).map((i) => i.id), ['2', '3']);
  const sorted = sortItems(all, { lat: 32.15, lng: 34.89 }).map((i) => i.id);
  assert.equal(sorted[0], '1');
  assert.equal(sorted.at(-1), '4', 'unlocated last');
  const byName = sortItems(all, null).map((i) => i.name);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b, 'he')));
});

test('filters round-trip through the URL', () => {
  const f = emptyFilters();
  f.q = 'פילאטיס';
  f.plan = 'PLUS';
  f.cities = new Set(['תל אביב', 'הוד השרון']);
  f.amenities = new Set(["ג'קוזי"]);
  f.groups = new Set(['studio']);
  const back = paramsToFilters(new URLSearchParams(filtersToParams(f).toString()));
  assert.equal(back.q, f.q);
  assert.equal(back.plan, 'PLUS');
  assert.deepEqual([...back.cities], [...f.cities]);
  assert.deepEqual([...back.amenities], ["ג'קוזי"]);
  assert.deepEqual([...back.groups], ['studio']);
});

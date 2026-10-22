// Reverse-engineering report: run `npm run probe` to see exactly what the live site exposes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { request } from '../server/http.js';
import { parseLocationsFilters, discoverClubUrls, parseClubPage } from '../server/sources/html.js';
import { loadFromWpRest } from '../server/sources/wpRest.js';

const base = config.baseUrl;
const report = { baseUrl: base, at: new Date().toISOString(), checks: [] };
const ok = (name, detail) => (report.checks.push({ name, ok: true, detail }), console.log(`  \x1b[32m✔\x1b[0m ${name}`, detail ?? ''));
const bad = (name, detail) => (report.checks.push({ name, ok: false, detail }), console.log(`  \x1b[31m✘\x1b[0m ${name}`, detail ?? ''));

console.log(`\nProbing ${base}\n`);

// 1. Locations page and its embedded filter lists.
try {
  const { text } = await request(`${base}/locations/`, { retries: 1 });
  const f = parseLocationsFilters(text);
  ok('locations page', `${f.city.length} cities, ${f.types.length} types, ${f.styles.length} styles, ${f.plans.length} plans`);
  report.filters = { raw: f.raw, sample: { city: f.city.slice(0, 5), types: f.types.slice(0, 5), plans: f.plans } };
  // Look for AJAX hooks the page uses for results.
  const hints = [...new Set(text.match(/(admin-ajax\.php|wp-json\/[a-z0-9\-_/]+|action["']?\s*[:=]\s*["'][a-z_\-]+["']|jet-smart-filters|elementor\/v1\/[a-z\-/]+)/gi) || [])];
  report.ajaxHints = hints.slice(0, 30);
  hints.length ? ok('AJAX hints in page source', hints.slice(0, 8).join(' | ')) : bad('AJAX hints in page source', 'none found');
} catch (e) {
  bad('locations page', e.message);
}

// 2. WordPress REST API.
try {
  const { json } = await request(`${base}/wp-json/`, { retries: 1, accept: 'application/json' }).then((r) => ({ json: JSON.parse(r.text) }));
  const routes = Object.keys(json.routes || {});
  const interesting = routes.filter((r) => /club|location|filter|jet|map/i.test(r));
  ok('REST index /wp-json/', `${routes.length} routes; relevant: ${interesting.slice(0, 10).join(', ') || 'none'}`);
  report.restRoutes = interesting;
} catch (e) {
  bad('REST index /wp-json/', e.message);
}
try {
  const res = await loadFromWpRest(base, { log: (m) => console.log(`      ${m}`) });
  ok('REST club posts', `${res.records.length} clubs via /${res.meta.restBase}`);
  report.rest = { meta: res.meta, sample: res.records.slice(0, 3) };
  const withCoords = res.records.filter((r) => r.lat != null).length;
  const withAddr = res.records.filter((r) => r.address).length;
  (withCoords ? ok : bad)('coordinates in REST data', `${withCoords}/${res.records.length}`);
  (withAddr ? ok : bad)('addresses in REST data', `${withAddr}/${res.records.length}`);
} catch (e) {
  bad('REST club posts', e.message);
}

// 3. Sitemaps.
let urls = [];
try {
  urls = await discoverClubUrls(base, { log: (m) => console.log(`      ${m}`) });
  (urls.length ? ok : bad)('club URLs from sitemaps', urls.length);
  report.sitemapSample = urls.slice(0, 5);
} catch (e) {
  bad('club URLs from sitemaps', e.message);
}

// 4. One club page, parsed.
const sampleUrl = urls[0] || report.rest?.sample?.[0]?.url;
if (sampleUrl) {
  try {
    const { text } = await request(sampleUrl, { retries: 1 });
    const parsed = parseClubPage(text, sampleUrl);
    ok('club page parse', `${parsed.name} | ${parsed.address} | plans ${parsed.plans.join(',')} | coords ${parsed.lat ?? 'none'}`);
    report.clubSample = { ...parsed, description: parsed.description?.slice(0, 160), notes: parsed.notes?.slice(0, 160) };
  } catch (e) {
    bad('club page parse', e.message);
  }
}

await fs.mkdir(config.dataDir, { recursive: true });
const out = path.join(config.dataDir, 'probe-report.json');
await fs.writeFile(out, JSON.stringify(report, null, 2));
console.log(`\nFull report written to ${out}\n`);

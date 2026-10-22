// Build a static copy of the app into dist/ for Netlify, GitHub Pages or any static host.
// Uses the data already collected in data/locations.json (run `npm run refresh` first).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../server/config.js';
import { GROUPS, OTHER_GROUP, PLAN_ORDER } from '../server/normalize.js';

const require = createRequire(import.meta.url);
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const dist = path.join(config.root, 'dist');

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, 'data'), { recursive: true });

// App files
await fs.cp(path.join(config.root, 'public'), dist, { recursive: true });
await fs.cp(path.join(pkgDir('leaflet'), 'dist'), path.join(dist, 'vendor/leaflet'), { recursive: true });
await fs.cp(path.join(pkgDir('leaflet.markercluster'), 'dist'), path.join(dist, 'vendor/markercluster'), { recursive: true });

// Switch the page into static mode.
const indexPath = path.join(dist, 'index.html');
const html = await fs.readFile(indexPath, 'utf8');
await fs.writeFile(indexPath, html.replace('<html lang="he" dir="rtl">', '<html lang="he" dir="rtl" data-mode="static">'));

// Data
let dataset = null;
try {
  dataset = JSON.parse(await fs.readFile(path.join(config.dataDir, 'locations.json'), 'utf8'));
} catch {
  console.warn('\n  No data/locations.json yet: the site will show a "no data" message.');
  console.warn('  Run `npm run refresh` (or the GitHub Action), then build again.\n');
}
const items = dataset?.items || [];
const list = {
  version: dataset?.version ?? 0,
  generatedAt: dataset?.generatedAt ?? null,
  source: dataset?.source ?? null,
  groups: [...GROUPS.map(({ kw, ...g }) => g), OTHER_GROUP],
  plans: PLAN_ORDER,
  items: items.map(({ notes, description, hours, ...light }) => light),
};
const details = Object.fromEntries(items.map((i) => [i.id, { hours: i.hours, notes: i.notes, description: i.description }]));
await fs.writeFile(path.join(dist, 'data/list.json'), JSON.stringify(list));
await fs.writeFile(path.join(dist, 'data/details.json'), JSON.stringify(details));

const located = items.filter((i) => i.lat != null).length;
console.log(`\n  Built dist/ with ${items.length} locations (${located} on the map).`);
console.log('  Upload the dist folder to Netlify, or let Netlify build it from GitHub.\n');

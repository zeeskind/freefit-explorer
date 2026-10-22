// Rebuild data/locations.json from the live site without starting the web server.
// Geocoding continues until finished; press Ctrl+C to stop (progress is cached).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { DataService } from '../server/dataService.js';

await fs.mkdir(config.dataDir, { recursive: true });
const service = new DataService({ ...config });
await service.geocoder.load();
await service.refresh();
const s = service.publicStatus();
if (s.state === 'error') {
  console.error(`\nRefresh failed: ${s.error}`);
  process.exit(1);
}
console.log(`\nSaved ${s.count} locations (source: ${s.source}). Geocoding addresses now…`);
const timer = setInterval(() => {
  const p = service.publicStatus();
  if (p.state === 'geocoding') process.stdout.write(`\r  ${p.phase}: ${p.done}/${p.total}   `);
}, 5000);
await service.geocoding;
clearInterval(timer);
await service.geocoder.save();

// Wait for the last save, then make sure the file really exists.
await service.flush();
const file = path.join(config.dataDir, 'locations.json');
try {
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const onMap = saved.items.filter((i) => i.lat != null).length;
  const has = (k) => saved.items.filter((i) => i.contactKinds?.includes(k)).length;
  console.log(`\nDone. ${saved.items.length} locations saved to ${file}, ${onMap} on the map.`);
  console.log(`Contacts: ${has('whatsapp')} with WhatsApp (published by the business), ${has('phone')} with a phone, ${has('email')} with email, ${has('website')} with a website.`);
  console.log(service.geocoder.summary());
  if (saved.items.length && onMap === 0) {
    console.warn('Warning: no address could be placed on the map. The geocoding service may be blocking this machine.');
  }
} catch (e) {
  console.error(`\nCould not write ${file}: ${e.message}`);
  process.exit(1);
}
process.exit(0);

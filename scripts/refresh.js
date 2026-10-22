// Rebuild data/locations.json from the live site without starting the web server.
// Geocoding continues until finished; press Ctrl+C to stop (progress is cached).
import { config } from '../server/config.js';
import { DataService } from '../server/dataService.js';

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
}, 1000);
await service.geocoding;
clearInterval(timer);
console.log(`\nDone. ${service.publicStatus().located} of ${s.count} locations are on the map.`);
await service.geocoder.save();
process.exit(0);

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exec } from 'node:child_process';
import { config } from './config.js';
import { DataService } from './dataService.js';

const require = createRequire(import.meta.url);
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

export function createApp(service) {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(service.publicStatus());
  });

  app.get('/api/locations', (req, res) => {
    const data = service.list();
    if (!data) return res.status(503).json({ error: 'not_ready', status: service.publicStatus() });
    const etag = `"v${data.version}"`;
    res.set({ ETag: etag, 'Cache-Control': 'no-cache' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json(data);
  });

  app.get('/api/locations/:id', (req, res) => {
    const item = service.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  });

  app.post('/api/refresh', (_req, res) => {
    service.refresh();
    res.status(202).json(service.publicStatus());
  });

  // Vendor assets straight from node_modules: no CDN needed for the map library.
  app.use('/vendor/leaflet', express.static(path.join(pkgDir('leaflet'), 'dist'), { maxAge: '7d' }));
  app.use('/vendor/markercluster', express.static(path.join(pkgDir('leaflet.markercluster'), 'dist'), { maxAge: '7d' }));

  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));
  return app;
}

async function main() {
  const service = new DataService(config);
  await service.init();
  const app = createApp(service);
  app.listen(config.port, config.host, () => {
    const url = `http://localhost:${config.port}`;
    console.log(`\n  Freefit Explorer is running at ${url}\n`);
    if (config.openBrowser) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(path.join('server', 'index.js'))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

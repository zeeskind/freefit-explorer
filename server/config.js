import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  root,
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',

  // Where the Freefit site lives. Point this at the mock server in tests.
  baseUrl: (env.FREEFIT_BASE_URL || 'https://website.freefit.co.il').replace(/\/+$/, ''),

  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),

  // Rebuild the dataset automatically when it is older than this.
  cacheTtlHours: num(env.CACHE_TTL_HOURS, 24),

  // Be polite to their server.
  scrapeConcurrency: num(env.SCRAPE_CONCURRENCY, 4),
  requestDelayMs: num(env.REQUEST_DELAY_MS, 120),
  requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 25000),
  userAgent:
    env.USER_AGENT ||
    'Mozilla/5.0 (compatible; FreefitExplorer/1.0; personal-use location browser)',

  // Force a single data source: "auto" | "rest" | "sitemap" | "archive"
  sourceMode: env.SOURCE_MODE || 'auto',

  geocode: {
    enabled: env.GEOCODE !== 'off',
    endpoint: env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search',
    // Nominatim's usage policy allows at most one request per second.
    minIntervalMs: num(env.GEOCODE_INTERVAL_MS, 1100),
    userAgent: env.GEOCODE_USER_AGENT || 'FreefitExplorer/1.0 (personal use; https://github.com/)',
  },

  openBrowser: env.OPEN_BROWSER ? env.OPEN_BROWSER !== '0' : !env.DOCKER,
};

// Israel (incl. Eilat and the Golan) with a little slack.
export const ISRAEL_BBOX = { south: 29.3, north: 33.5, west: 34.15, east: 35.95 };

export function inIsrael(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= ISRAEL_BBOX.south &&
    lat <= ISRAEL_BBOX.north &&
    lng >= ISRAEL_BBOX.west &&
    lng <= ISRAEL_BBOX.east
  );
}

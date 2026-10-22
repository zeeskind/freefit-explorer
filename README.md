# Freefit Explorer

A fast, map-first replacement for the Freefit locations page
(https://website.freefit.co.il/locations/), for personal use.

Every Freefit venue on one clustered map. Filtering is instant and happens entirely
in your browser: plan, place type, city, activity, training style, amenities and live
text search. Hebrew, right-to-left, works on desktop and mobile.

## Start it

You need [Node.js](https://nodejs.org) 18 or newer (the LTS download is fine).

| How | What to do |
| --- | --- |
| Windows | Double-click `start.bat` |
| macOS | Double-click `start.command` (first time: right-click → Open) |
| Linux / terminal | `./start.sh`, or `npm install` then `npm start` |
| Docker | `docker compose up -d`, then open http://localhost:3000 |

The browser opens at http://localhost:3000 by itself.

**First run:** the app reads every location from Freefit's site. That takes a few
minutes, and a progress screen shows what it is doing. After that, everything loads
instantly from `data/`, and the data refreshes in the background every 24 hours.
You can also press "רענון נתונים" at the bottom of the panel.

**Map pins:** Freefit's pages show addresses, not coordinates. So the app looks each
address up on OpenStreetMap. Their free service allows one lookup per second, so:

- within a few minutes, every place gets a pin in the middle of its city
  (hollow pins, marked "מיקום משוער");
- over roughly 45 minutes, pins move to the exact address. You can use the app
  the whole time; the map updates itself.

This happens once. Results are cached in `data/geocode-cache.json`.

## Host it on Netlify

Netlify serves a static build: all filtering runs in the browser, and the data is a
prebuilt JSON file. Collecting the data needs a long-running process (the address
lookups take about 45 minutes the first time), so that runs elsewhere:

- **By hand:** `npm run refresh`, then `npm run build:site`, then drag the `dist`
  folder onto https://app.netlify.com/drop.
- **Automatically:** push this project to GitHub. `.github/workflows/update-data.yml`
  collects fresh data every night and commits it to `data/`, and Netlify (connected to
  the repo, settings in `netlify.toml`) rebuilds on every commit.

The static site has no "רענון נתונים" button; data updates come from the steps above.

## Using it

- **Search** matches name, address, city, activity and amenities. Hebrew final
  letters and vowel marks don't matter. Press Enter to zoom the map to the results.
- **Filters** combine with AND. Inside one filter, choices combine with OR, except
  amenities, where a place must have all of the ones you pick.
- **Numbers on every option** show exactly how many results you'd get if you picked it.
  Options that would give zero results are greyed out.
- **"רק באזור המפה"** makes the list follow the map. Turn it off to list every result.
- **Locate button** (top of the map) sorts the list by distance from you.
- **The URL keeps your state.** Bookmark or share a link to come back to the same
  filters, map view and selected place.
- **Esc** closes the details card.

## Checking the connection to Freefit

```
npm run probe
```

This prints which of Freefit's data sources answer and how one club page parses, and
saves a full report to `data/probe-report.json`. Run it first if anything looks wrong.

## How it works

```
Freefit site ──► server (Node) ──► data/locations.json ──► browser (all filtering)
                    │
                    └─► OpenStreetMap address lookup ──► data/geocode-cache.json
```

What the site exposes:

- Locations are WordPress posts of type `club`, at `/club/<name>/`.
- Categories and training styles are the `club-type` and `club-activity` taxonomies.
- Plans are `?route=smart|plus|pro|max` links on each club page.
- The `/locations/` page embeds the full lists of cities, categories, styles and plans.

The server tries three sources in order and uses the first that works:

1. The WordPress REST API (`/wp-json/wp/v2/club`), including any coordinates
   stored in custom fields.
2. The sitemap (`/wp-sitemap.xml`), then each club page.
3. The category listing pages (`/club-type/<name>/page/N/`).

Whichever source wins, club pages fill in what's missing (address, hours, plans,
notes, image). If categories still aren't known, the server reads the category
listing pages to fill them in.

All requests to Freefit come from your own server, so the browser never hits
cross-origin limits. Requests are throttled (4 at a time, with a short pause between).

### Files

```
server/
  index.js          web server and API
  dataService.js    picks a source, enriches, saves, runs address lookup
  sources/wpRest.js WordPress REST source
  sources/html.js   sitemap, category pages, club page and filter-list parsing
  normalize.js      common data shape, colour groups, amenities, cities
  geocode.js        rate-limited OpenStreetMap lookup with disk cache
  http.js           retries, timeouts, concurrency limit
public/
  index.html, styles.css, app.js   the app
  filter.js         search and filter logic (also used by the tests)
scripts/
  probe.js          connection report
  refresh.js        rebuild the data without starting the server
test/               automated tests and a mock Freefit site
```

### API

| Endpoint | Returns |
| --- | --- |
| `GET /api/locations` | all locations (light fields), colour groups, plans |
| `GET /api/locations/:id` | one location with hours, notes and description |
| `GET /api/status` | build or lookup progress and counts |
| `POST /api/refresh` | starts a rebuild from the live site |

## Settings

Set these as environment variables, e.g. `PORT=8080 npm start`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | web server port |
| `OPEN_BROWSER` | `1` (`0` in Docker) | open the browser on start |
| `CACHE_TTL_HOURS` | `24` | rebuild the data when older than this |
| `SOURCE_MODE` | `auto` | force one source: `rest`, `sitemap` or `archive` |
| `SCRAPE_CONCURRENCY` | `4` | parallel requests to Freefit |
| `GEOCODE` | on | set to `off` to skip address lookup |
| `GEOCODE_URL` | OpenStreetMap Nominatim | any Nominatim-compatible service |
| `DATA_DIR` | `./data` | where the cache lives |
| `FREEFIT_BASE_URL` | `https://website.freefit.co.il` | site to read from |

## Tests

```
npm test
```

17 tests run against a local mock of the Freefit site. They cover all three data
sources, page parsing, the filters and the API. To try the UI without touching the
real site:

```
node test/mockFreefit.js norest 400        # prints a URL, e.g. http://127.0.0.1:5xxxx
FREEFIT_BASE_URL=<that url> GEOCODE_URL=<that url>/geocode GEOCODE_INTERVAL_MS=5 DATA_DIR=/tmp/ff npm start
```

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Loading screen says the build failed | Check your internet connection, then run `npm run probe` and look at which checks fail. |
| Places listed but few pins | Address lookup is still running; the progress pill on the map shows how far along it is. |
| Many pins sit in the middle of a city | Those addresses weren't found on OpenStreetMap. Navigation buttons still use the full address. |
| Categories look wrong after Freefit changes their site | Run `npm run probe` and check `data/probe-report.json`; delete `data/locations.json` to force a clean rebuild. |
| Port 3000 is taken | `PORT=3001 npm start` |

## Notes

- Built for personal use. It reads public pages at a gentle pace; please keep it that way.
- Map tiles © OpenStreetMap contributors, © CARTO. Address lookup by OpenStreetMap Nominatim.
- Not affiliated with Freefit.

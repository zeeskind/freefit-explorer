// A local stand-in for website.freefit.co.il built from the structures observed on the
// real site (Elementor club pages, filter <select>s on /locations/, WordPress REST,
// core sitemaps, taxonomy archives) plus a fake Nominatim geocoder.
//
// mode: 'rest'      → REST API works (with ACF coordinates on some posts)
//       'norest'    → REST answers 401 rest_forbidden; sitemaps work
//       'archive'   → REST and sitemaps blocked; only taxonomy archives work
import http from 'node:http';
import { wpSlugify } from '../server/sources/html.js';

const CITIES = {
  'תל אביב': [32.0853, 34.7818],
  'חיפה': [32.794, 34.9896],
  'ירושלים': [31.7683, 35.2137],
  'הוד השרון': [32.15, 34.8883],
  'רמת גן': [32.068, 34.8248],
  'באר שבע': [31.2518, 34.7913],
  'נתניה': [32.3215, 34.8532],
  'אילת': [29.5577, 34.9519],
};
const TYPES = ['חדר כושר', 'יוגה ופילאטיס', 'בריכה', 'אומנויות לחימה', 'קרוספיט(R) ופונקציונלי', 'שיעורי סטודיו', 'אימוני חוץ'];
const STYLES = ['פילאטיס מכשירים', 'TRX', 'ספינינג', 'יוגה', 'סאונה', 'חניה', 'מקלחות', "ג'קוזי", 'אגרוף תאילנדי', 'שחייה'];
const PLANS = ['SMART', 'PLUS', 'PRO', 'MAX'];
const STREETS = ['הרצל', 'ויצמן', 'בן גוריון', 'סמטת הר גילה', 'ז׳בוטינסקי', 'אחד העם', 'הנביאים'];

export function makeClubs(n = 40) {
  const cityNames = Object.keys(CITIES);
  return Array.from({ length: n }, (_, i) => {
    const city = cityNames[i % cityNames.length];
    const types = [TYPES[i % TYPES.length], ...(i % 5 === 0 ? [TYPES[(i + 3) % TYPES.length]] : [])];
    const styles = [STYLES[i % STYLES.length], STYLES[(i * 3 + 1) % STYLES.length]];
    const minPlan = i % 4;
    const [lat, lng] = CITIES[city];
    return {
      id: 29000 + i,
      // A few Hebrew slugs, as on the real site (/club/אומדה/).
      slug: i === 0 ? 'אומדה' : `club-${i}`,
      name: i === 0 ? 'אומדה' : `מועדון בדיקה ${i}`,
      city,
      address: `${STREETS[i % STREETS.length]} ${i + 3}, ${city}`,
      types,
      styles: [...new Set(styles)],
      plans: PLANS.slice(minPlan),
      // Half of the clubs carry coordinates in ACF; the rest need geocoding.
      coords: i % 2 === 0 ? [lat + (i % 7) * 0.003, lng - (i % 5) * 0.003] : null,
    };
  });
}

const encSlug = (s) => encodeURIComponent(s).toLowerCase();
// What WordPress's sanitize_html_class() does to a percent-encoded slug.
const classSlug = (s) => encodeURIComponent(wpSlugify(s)).toLowerCase().replace(/%/g, '');

function clubPage(c, base) {
  const routeLinks = c.plans.map((p) => `<a class="elementor-button" href="${base}/locations/?route=${p.toLowerCase()}">${p}</a>`).join(' ');
  const taxClasses = [...c.types.map((t) => `club-type-${classSlug(t)}`), ...c.styles.map((s) => `club-activity-${classSlug(s)}`)].join(' ');
  const desc = 'הסיבה שאנחנו כלכך אוהבים את מועדון שלנו היא היכולת של מתאמנים להגיע להשיגים שהם אפילו לא חשבו שיצליחו. החלק הכי מרגש זה בו מתאמנים מצליחים לפרוץ גבולות אישיים.';
  const notes = 'מועדון זה עובד עם מערכת הזמנות של ARBOX ! ניתן להזמין שיעור דרך אפליקצית freefit. ניתן לבטל אימון ערב עד 12 שעות לפני תחילתו.';
  const block = `
    <div class="elementor-widget-heading"><div class="elementor-widget-container"><h2 class="elementor-heading-title">${c.name}</h2></div></div>
    <div class="elementor-widget-text-editor"><div class="elementor-widget-container"><p>${c.address}</p></div></div>`;
  return `<!doctype html><html lang="he-IL" dir="rtl"><head>
<meta charset="UTF-8"><title>${c.name} – freefit לארגון שלך</title>
<meta property="og:title" content="${c.name} – freefit לארגון שלך" />
</head>
<body class="club-template-default single single-club postid-${c.id} elementor-default">
<header class="elementor-location-header"><nav><ul><li><a href="${base}/">דף הבית</a></li><li><a href="${base}/locations/">כל המקומות</a></li></ul></nav>
<img src="${base}/wp-content/uploads/2026/05/logo-1.webp"></header>
<main id="content">
<div data-elementor-type="single-post" class="elementor post-${c.id} club type-club status-publish ${taxClasses}">
  ${block}
  <div class="elementor-widget-text-editor"><div class="elementor-widget-container"><p>${desc}</p></div></div>
  <h2 class="elementor-heading-title">מידע שימושי</h2>
  <ul class="elementor-icon-list-items"><li class="elementor-icon-list-item"><span class="elementor-icon-list-text">${c.address}</span></li></ul>
  <h2 class="elementor-heading-title">שעות פתיחה</h2>
  <div class="elementor-widget-text-editor"><p>ימים א׳-ה׳: 06:00-22:00</p><p>ימי שישי: 07:30-14:30</p><p>ימי שבת: 10:30-20:00</p></div>
  <h2 class="elementor-heading-title">חשוב לדעת</h2>
  <div class="elementor-widget-text-editor"><p>${notes}</p></div>
  <h3 class="elementor-heading-title">מסלולים</h3>${routeLinks}
  <h3 class="elementor-heading-title">כתובת</h3>
  <!-- mobile duplicate, as on the real page -->
  ${block}
  <img src="${base}/wp-content/uploads/2026/06/image_small_${c.id}_1-1.webp" />
  <h3 class="elementor-heading-title">שעות פתיחה</h3><p>ימים א׳-ה׳: 06:00-22:00</p>
  ${c.coords && c.id % 4 === 0 ? `<iframe src="https://maps.google.com/maps?q=${c.coords[0]},${c.coords[1]}&z=15&output=embed"></iframe>` : ''}
</div>
<h2 class="elementor-heading-title">דברו איתנו</h2><form><input name="name"><select name="subject"><option>הצטרפות כארגון</option></select></form>
</main>
<footer class="elementor-location-footer"><img src="${base}/wp-content/uploads/2026/05/footer-logo.webp"><a href="#">תקנון</a></footer>
</body></html>`;
}

function locationsPage(clubs) {
  const cities = [...new Set(clubs.map((c) => c.city))];
  const opt = (v, l) => `<option value="${v}">${l}</option>`;
  return `<!doctype html><html lang="he"><body><main>
<h2>איפה מתאמנים היום?</h2>
<form class="jet-smart-filters">
 <select class="jet-select__control" name="city" data-placeholder="עיר">${opt('', 'עיר')}${cities.map((c) => opt(encSlug(wpSlugify(c)), c)).join('')}</select>
 <select class="jet-select__control" name="club-type" data-placeholder="פעילות">${opt('', 'פעילות')}${TYPES.map((t, i) => opt(String(100 + i), t)).join('')}</select>
 <select class="jet-select__control" name="club-activity" data-placeholder="סגנון פעילות">${opt('', 'סגנון פעילות')}${STYLES.map((s) => opt(encSlug(wpSlugify(s)), s)).join('')}</select>
 <select class="jet-select__control" name="route" data-placeholder="מסלול">${opt('', 'מסלול')}${PLANS.map((p) => opt(p.toLowerCase(), p)).join('')}</select>
 <button>חיפוש</button>
</form>
<script>var ajaxurl = "/wp-admin/admin-ajax.php"; var JetSmartFilterSettings = {"ajaxurl":"/wp-admin/admin-ajax.php"};</script>
</main></body></html>`;
}

export function startMock({ mode = 'rest', clubs = makeClubs(), perPage = 15 } = {}) {
  const stats = { requests: 0, byPrefix: {} };
  const termId = (list, label) => 100 + list.indexOf(label);
  const terms = {
    'club-type': TYPES.map((t, i) => ({ id: 100 + i, name: t, slug: encSlug(wpSlugify(t)) })),
    'club-activity': STYLES.map((s, i) => ({ id: 200 + i, name: s, slug: encSlug(wpSlugify(s)) })),
    route: PLANS.map((p, i) => ({ id: 300 + i, name: p, slug: p.toLowerCase() })),
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = decodeURIComponent(u.pathname);
    stats.requests++;
    const prefix = path.split('/')[1] || '/';
    stats.byPrefix[prefix] = (stats.byPrefix[prefix] || 0) + 1;
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // Fake Nominatim
    if (path === '/geocode') {
      const q = u.searchParams.get('q') || '';
      const city = Object.keys(CITIES).find((c) => q.includes(c));
      if (!city) return send(200, [], 'application/json');
      const [lat, lng] = CITIES[city];
      const isCityOnly = q.trim().startsWith(city);
      const h = [...q].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7);
      return send(200, [{ lat: String(isCityOnly ? lat : lat + (h % 20) * 0.001), lon: String(isCityOnly ? lng : lng + (h % 13) * 0.001) }], 'application/json');
    }

    if (path === '/locations/' || path === '/locations') return send(200, locationsPage(clubs));

    // WordPress REST
    if (path.startsWith('/wp-json')) {
      if (mode !== 'rest') return send(401, { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' }, 'application/json');
      if (path === '/wp-json/wp/v2/types') return send(200, { post: { slug: 'post', rest_base: 'posts' }, club: { slug: 'club', rest_base: 'club', name: 'מועדונים' } }, 'application/json');
      if (path === '/wp-json/wp/v2/taxonomies')
        return send(200, {
          'club-type': { slug: 'club-type', name: 'סוגי מועדון', rest_base: 'club-type' },
          'club-activity': { slug: 'club-activity', name: 'סגנון פעילות', rest_base: 'club-activity' },
          route: { slug: 'route', name: 'מסלול', rest_base: 'route' },
        }, 'application/json');
      const m = path.match(/^\/wp-json\/wp\/v2\/([a-z-]+)$/);
      if (m && terms[m[1]]) return send(200, terms[m[1]], 'application/json', { 'X-WP-TotalPages': '1' });
      if (m && m[1] === 'club') {
        const pp = Math.min(Number(u.searchParams.get('per_page')) || 10, perPage);
        const page = Number(u.searchParams.get('page')) || 1;
        const total = Math.ceil(clubs.length / pp);
        if (page > total) return send(400, { code: 'rest_post_invalid_page_number' }, 'application/json');
        const slice = clubs.slice((page - 1) * pp, page * pp).map((c) => ({
          id: c.id,
          slug: encSlug(c.slug),
          link: `${base}/club/${encSlug(c.slug)}/`,
          title: { rendered: c.name.replace('אומדה', 'אומדה &#8211; חדר כושר') },
          content: { rendered: '<p>תיאור קצר של המקום.</p>' },
          'club-type': c.types.map((t) => termId(TYPES, t)),
          'club-activity': c.styles.map((s) => 200 + STYLES.indexOf(s)),
          route: c.plans.map((p) => 300 + PLANS.indexOf(p)),
          acf: c.coords ? { address: c.address, location: { address: c.address, lat: String(c.coords[0]), lng: String(c.coords[1]) } } : { address: c.address },
          _links: {},
        }));
        return send(200, slice, 'application/json', { 'X-WP-TotalPages': String(total), 'X-WP-Total': String(clubs.length) });
      }
      return send(404, { code: 'rest_no_route' }, 'application/json');
    }

    // Sitemaps
    if (path === '/wp-sitemap.xml') {
      if (mode === 'archive') return send(404, 'not found');
      return send(200, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${base}/wp-sitemap-posts-page-1.xml</loc></sitemap>
<sitemap><loc>${base}/wp-sitemap-posts-club-1.xml</loc></sitemap>
<sitemap><loc>${base}/wp-sitemap-taxonomies-club-type-1.xml</loc></sitemap></sitemapindex>`, 'application/xml');
    }
    if (path === '/wp-sitemap-posts-club-1.xml' && mode !== 'archive')
      return send(200, `<?xml version="1.0"?><urlset>${clubs.map((c) => `<url><loc>${base}/club/${encSlug(c.slug)}/</loc></url>`).join('')}</urlset>`, 'application/xml');
    if (/sitemap/.test(path)) return send(404, 'not found');

    // Club pages
    const cm = path.match(/^\/club\/([^/]+)\/?$/);
    if (cm) {
      const c = clubs.find((x) => x.slug === cm[1]);
      return c ? send(200, clubPage(c, base)) : send(404, 'not found');
    }

    // Taxonomy archives, 10 per page
    const am = path.match(/^\/(club-type|club-activity)\/([^/]+)\/(?:page\/(\d+)\/)?$/);
    if (am) {
      const [, tax, slug, pg] = am;
      const list = tax === 'club-type' ? TYPES : STYLES;
      const label = list.find((l) => wpSlugify(l) === slug);
      if (!label) return send(404, 'not found');
      const members = clubs.filter((c) => (tax === 'club-type' ? c.types : c.styles).includes(label));
      const page = Number(pg) || 1;
      const slice = members.slice((page - 1) * 10, page * 10);
      if (!slice.length) return send(404, 'not found');
      return send(200, `<html><body><main><h1>Type: ${label}</h1>${slice.map((c) => `<article><h2><a href="${base}/club/${encSlug(c.slug)}/">${c.name}</a></h2></article>`).join('')}</main>
<footer><a href="${base}/club/${encSlug(clubs[0].slug)}/">קישור קבוע בפוטר</a></footer></body></html>`);
    }

    send(404, 'not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, stats, clubs, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// `node test/mockFreefit.js [mode]` runs the mock standalone for manual UI testing.
if (process.argv[1]?.endsWith('mockFreefit.js') && !process.env.NODE_TEST_CONTEXT) {
  const mode = process.argv[2] || 'rest';
  const n = Number(process.argv[3]) || 400;
  const m = await startMock({ mode, clubs: makeClubs(n) });
  console.log(`Mock Freefit (${mode}, ${n} clubs) at ${m.url}`);
}

import {
  normalizeText, emptyFilters, indexItems, applyFilters, facetCounts, activeFilterCount,
  inBounds, distanceKm, sortItems, filtersToParams, paramsToFilters, clusterAction,
} from './filter.js';
import { contactActions, websiteInfo, bookingInfo, socialLinks, searchUrl, safeUrl } from './contacts.js';

/* ------------------------------ helpers ------------------------------ */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('he-IL');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isMobile = () => matchMedia('(max-width: 820px)').matches;
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'עודכן עכשיו';
  if (mins < 60) return `עודכן לפני ${mins} דק׳`;
  const h = Math.round(mins / 60);
  if (h < 48) return `עודכן לפני ${h} שע׳`;
  return `עודכן לפני ${Math.round(h / 24)} ימים`;
}

// Static hosting (Netlify etc.): data comes from prebuilt JSON files instead of the API.
const STATIC = document.documentElement.dataset.mode === 'static';
let staticDetails = null;

/* ------------------------------- state ------------------------------- */

const state = {
  items: [],
  byId: new Map(),
  groups: [],
  groupById: new Map(),
  plans: [],
  amenities: [],
  f: emptyFilters(),
  filtered: [],
  filteredKey: '',
  origin: null,          // user location for distance sorting
  selectedId: null,
  version: null,
  limitToMap: true,
  listLimit: 60,
  details: new Map(),    // id → full record (lazy)
};

/* -------------------------------- map -------------------------------- */

const map = L.map('map', { zoomControl: false, minZoom: 7, maxBounds: [[28.8, 33.2], [34.2, 36.6]] }).setView([31.95, 34.95], 8);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
// No-key tile servers. If the first one fails to deliver any tile, switch to the next.
const TILE_SOURCES = [
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  },
  {
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    options: {
      subdomains: 'abc',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, tiles: <a href="https://www.hotosm.org/">HOT</a> / <a href="https://openstreetmap.fr/">OSM France</a>',
    },
  },
];
let tileLayer = null;
function useTiles(index) {
  const src = TILE_SOURCES[index];
  if (tileLayer) map.removeLayer(tileLayer);
  let loaded = 0;
  let failed = 0;
  tileLayer = L.tileLayer(src.url, src.options).addTo(map);
  tileLayer.on('tileload', () => loaded++);
  tileLayer.on('tileerror', () => {
    if (++failed >= 6 && loaded === 0 && index + 1 < TILE_SOURCES.length) useTiles(index + 1);
  });
}
useTiles(0);

const cluster = L.markerClusterGroup({
  chunkedLoading: true,
  showCoverageOnHover: false,
  // Clicks are handled below: small or stacked clusters open a list of their places.
  zoomToBoundsOnClick: false,
  spiderfyOnMaxZoom: false,
  maxClusterRadius: (z) => (z >= 16 ? 24 : z >= 14 ? 34 : 54),
  iconCreateFunction(c) {
    const n = c.getChildCount();
    const s = n < 10 ? 34 : n < 100 ? 40 : n < 1000 ? 48 : 56;
    return L.divIcon({ html: `<div class="cluster" style="width:${s}px;height:${s}px">${nf.format(n)}</div>`, className: '', iconSize: [s, s] });
  },
});
map.addLayer(cluster);

cluster.on('clusterclick', (e) => {
  const c = e.layer;
  const b = c.getBounds();
  const ids = c.getAllChildMarkers().map((m) => m.options.itemId);
  const action = clusterAction({
    count: ids.length,
    zoom: map.getZoom(),
    maxZoom: map.getMaxZoom(),
    spanMeters: b.getNorthEast().distanceTo(b.getSouthWest()),
  });
  if (action === 'zoom') map.flyToBounds(b, { padding: [40, 40], duration: 0.5 });
  else openClusterList(c.getLatLng(), ids, b);
});

/** A popup listing the places inside a cluster; picking one opens its details. */
function openClusterList(latlng, ids, bounds) {
  const items = sortItems(ids.map((id) => state.byId.get(id)).filter(Boolean), null);
  const box = document.createElement('div');
  box.className = 'cluster-list';
  const canZoom = map.getZoom() < map.getMaxZoom() && bounds.getNorthEast().distanceTo(bounds.getSouthWest()) > 30;
  box.innerHTML = `<div class="cl-head"><strong>${nf.format(items.length)} מקומות כאן</strong>${canZoom ? '<button type="button" class="link-btn" data-act="zoom">התקרבות</button>' : ''}</div>
    <ul>${items
      .map((it) => {
        const g = state.groupById.get(it.group);
        return `<li><button type="button" data-id="${esc(it.id)}"><span class="dot" style="background:${g?.color || '#6B7A86'}"></span><span class="cl-text"><span class="cl-name">${esc(it.name)}</span><span class="cl-sub">${esc(it.address || it.city || '')}</span></span>${badges(it)}</button></li>`;
      })
      .join('')}</ul>`;
  box.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="zoom"]')) {
      map.closePopup();
      map.flyToBounds(bounds, { padding: [40, 40], duration: 0.5 });
      return;
    }
    const b = ev.target.closest('[data-id]');
    if (!b) return;
    map.closePopup();
    select(b.dataset.id, { fromMap: true });
  });
  L.popup({ className: 'cluster-pop', maxWidth: 320, minWidth: 260, autoPanPadding: [24, 24] }).setLatLng(latlng).setContent(box).openOn(map);
}

/** Small contact badges for list rows and cluster lists. */
function badges(it) {
  const k = it.contactKinds || [];
  const out = [];
  if (k.includes('whatsapp')) out.push('<span class="cb wa" title="יש וואטסאפ שהעסק פרסם">WhatsApp</span>');
  if (k.includes('website')) out.push('<span class="cb" title="יש אתר">אתר</span>');
  return out.length ? `<span class="cbs">${out.join('')}</span>` : '';
}

const markers = new Map();
const iconCache = new Map();
let userMarker = null;

function iconFor(it, selected = false) {
  const approx = it.geo === 'city';
  const key = `${it.group}|${approx}|${selected}`;
  if (!iconCache.has(key)) {
    const color = state.groupById.get(it.group)?.color || '#6B7A86';
    iconCache.set(
      key,
      L.divIcon({
        className: `pin${approx ? ' approx' : ''}${selected ? ' selected' : ''}`,
        html: `<span style="--c:${color}"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 27],
        tooltipAnchor: [0, -26],
      })
    );
  }
  return iconCache.get(key);
}

function buildMarkers() {
  markers.clear();
  for (const it of state.items) {
    if (it.lat == null) continue;
    const m = L.marker([it.lat, it.lng], { icon: iconFor(it), keyboard: false, riseOnHover: true, itemId: it.id });
    m.bindTooltip(esc(it.name), { direction: 'top', className: 'tip' });
    m.on('click', () => select(it.id, { fromMap: true }));
    markers.set(it.id, m);
  }
}

const bounds = () => {
  const b = map.getBounds();
  return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
};

function fitResults() {
  const pts = state.filtered.filter((i) => i.lat != null).map((i) => [i.lat, i.lng]);
  if (!pts.length) return;
  if (pts.length === 1) map.flyTo(pts[0], 15, { duration: 0.6 });
  else map.flyToBounds(pts, { padding: [40, 40], maxZoom: 15, duration: 0.6 });
}

/* ------------------------------ updates ------------------------------ */

function update({ fit = false } = {}) {
  state.filtered = applyFilters(state.items, state.f);
  const key = state.filtered.map((i) => i.id).join(',');
  if (key !== state.filteredKey) {
    state.filteredKey = key;
    cluster.clearLayers();
    cluster.addLayers(state.filtered.map((i) => markers.get(i.id)).filter(Boolean));
    restoreSelectedMarker();
  }
  state.listLimit = 60;
  renderFacets();
  renderActiveChips();
  renderList();
  saveHash();
  if (fit) fitResults();
}

const updateSoon = debounce(update, 90);

/* ------------------------------ facets ------------------------------- */

function toggle(set, v) {
  set.has(v) ? set.delete(v) : set.add(v);
}

function renderFacets() {
  // Plans (single choice)
  const planCounts = facetCounts(state.items, state.f, 'plan');
  const allCount = applyFilters(state.items, { ...state.f, plan: '' }).length;
  $('#planSeg').innerHTML = ['', ...state.plans]
    .map((p) => {
      const n = p ? planCounts.get(p) || 0 : allCount;
      return `<button type="button" role="radio" aria-checked="${state.f.plan === p}" data-plan="${p}">${p || 'הכל'}<small>${nf.format(n)}</small></button>`;
    })
    .join('');

  // Place groups
  const gCounts = facetCounts(state.items, state.f, 'groups');
  $('#groupChips').innerHTML = state.groups
    .filter((g) => state.items.some((i) => i.group === g.id))
    .map((g) => {
      const n = gCounts.get(g.id) || 0;
      const on = state.f.groups.has(g.id);
      return `<button type="button" class="chip" aria-pressed="${on}" data-group="${g.id}" ${!n && !on ? 'disabled' : ''}><span class="dot" style="background:${g.color}"></span>${esc(g.label)} <span class="n">${nf.format(n)}</span></button>`;
    })
    .join('');

  // Amenities (all required)
  const aCounts = facetCounts(state.items, state.f, 'amenities');
  $('#amenityChips').innerHTML = state.amenities.length
    ? state.amenities
        .map((a) => {
          const n = aCounts.get(a) || 0;
          const on = state.f.amenities.has(a);
          return `<button type="button" class="chip" aria-pressed="${on}" data-amenity="${esc(a)}" ${!n && !on ? 'disabled' : ''}>${esc(a)} <span class="n">${nf.format(n)}</span></button>`;
        })
        .join('')
    : '<span class="combo-more">אין מידע על מתקנים בנתונים</span>';

  const cCounts = facetCounts(state.items, state.f, 'contact');
  $('#contactChips').innerHTML = CONTACT_KINDS.map(([k, label]) => {
    const n = cCounts.get(k) || 0;
    const on = state.f.contact.has(k);
    return `<button type="button" class="chip" aria-pressed="${on}" data-contact="${k}" ${!n && !on ? 'disabled' : ''}>${label} <span class="n">${nf.format(n)}</span></button>`;
  }).join('');

  combos.forEach((c) => c.render());
  renderSummaries();

  const n = activeFilterCount(state.f);
  const badge = $('#filterBadge');
  badge.hidden = !n;
  badge.textContent = n;
}

$('#planSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.f.plan = b.dataset.plan;
  update();
});
$('#groupChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  toggle(state.f.groups, b.dataset.group);
  update();
});
const CONTACT_KINDS = [
  ['whatsapp', 'וואטסאפ'],
  ['phone', 'טלפון'],
  ['website', 'אתר'],
];
const CONTACT_LABEL = Object.fromEntries(CONTACT_KINDS);
$('#contactChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-contact]');
  if (!b) return;
  toggle(state.f.contact, b.dataset.contact);
  update();
});
$('#amenityChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-amenity]');
  if (!b) return;
  toggle(state.f.amenities, b.dataset.amenity);
  update();
});

/** Searchable multi-select with live counts. */
function makeCombo(root, { facet, placeholder, values }) {
  root.innerHTML = `<input class="combo-input" type="search" autocomplete="off" placeholder="${esc(placeholder)}" /><div class="combo-list" role="listbox" aria-multiselectable="true"></div>`;
  const input = root.querySelector('input');
  const list = root.querySelector('.combo-list');
  let query = '';
  input.addEventListener('input', () => {
    query = normalizeText(input.value);
    render();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (!b || b.disabled) return;
    toggle(state.f[facet], b.dataset.v);
    update();
  });
  function render() {
    const counts = facetCounts(state.items, state.f, facet);
    const sel = state.f[facet];
    let opts = values().map((v) => ({ v, n: counts.get(v) || 0, s: sel.has(v) }));
    if (query) opts = opts.filter((o) => normalizeText(o.v).includes(query));
    opts.sort((a, b) => b.s - a.s || b.n - a.n || a.v.localeCompare(b.v, 'he'));
    const shown = opts.slice(0, 120);
    const top = list.scrollTop;
    let html = shown
      .map((o) => `<button type="button" class="opt" role="option" aria-checked="${o.s}" data-v="${esc(o.v)}" ${!o.n && !o.s ? 'disabled' : ''}><span class="box"></span><span class="label">${esc(o.v)}</span><span class="n">${nf.format(o.n)}</span></button>`)
      .join('');
    if (opts.length > shown.length) html += `<div class="combo-more">ועוד ${nf.format(opts.length - shown.length)}. הקלידו כדי לצמצם.</div>`;
    list.innerHTML = html || '<div class="combo-more">אין התאמות לחיפוש הזה</div>';
    list.scrollTop = top;
  }
  return { render, clear: () => { input.value = ''; query = ''; } };
}

/* Collapsible filter rows show what is selected while closed. */
function renderSummaries() {
  for (const el of document.querySelectorAll('[data-sum]')) {
    const sel = [...state.f[el.dataset.sum]];
    el.textContent = !sel.length ? 'הכל' : sel.length <= 2 ? sel.join(', ') : `${nf.format(sel.length)} נבחרו`;
    el.classList.toggle('on', sel.length > 0);
  }
}

document.querySelectorAll('.disc-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open);
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    body.hidden = !open;
    if (open) body.querySelector('.combo-input')?.focus({ preventScroll: true });
  });
});

const distinct = (key) => () => {
  const s = new Set();
  for (const it of state.items) (Array.isArray(it[key]) ? it[key] : [it[key]]).forEach((v) => v && s.add(v));
  return [...s];
};

const combos = [
  makeCombo($('#cityCombo'), { facet: 'cities', placeholder: 'חיפוש עיר', values: distinct('city') }),
  makeCombo($('#typeCombo'), { facet: 'types', placeholder: 'חדר כושר, בריכה, ריקוד…', values: distinct('types') }),
  makeCombo($('#styleCombo'), { facet: 'styles', placeholder: 'פילאטיס מכשירים, TRX, ספינינג…', values: distinct('styles') }),
];

/* --------------------------- active chips ---------------------------- */

function renderActiveChips() {
  const f = state.f;
  const chips = [];
  if (f.q) chips.push(['q', '', `“${f.q}”`]);
  if (f.plan) chips.push(['plan', '', `מסלול ${f.plan}`]);
  for (const g of f.groups) chips.push(['groups', g, state.groupById.get(g)?.label || g]);
  for (const k of ['cities', 'types', 'styles', 'amenities']) for (const v of f[k]) chips.push([k, v, v]);
  for (const v of f.contact) chips.push(['contact', v, `יש ${CONTACT_LABEL[v]}`]);
  $('#activeChips').innerHTML = chips
    .map(([k, v, label]) => `<button type="button" class="pill" data-k="${k}" data-v="${esc(v)}" aria-label="הסרת הסינון ${esc(label)}">${X_ICON}${esc(label)}</button>`)
    .join('');
}

$('#activeChips').addEventListener('click', (e) => {
  const b = e.target.closest('.pill');
  if (!b) return;
  const { k, v } = b.dataset;
  if (k === 'q') {
    state.f.q = '';
    $('#q').value = '';
  } else if (k === 'plan') state.f.plan = '';
  else state.f[k].delete(v);
  update();
});

function resetFilters() {
  state.f = emptyFilters();
  $('#q').value = '';
  combos.forEach((c) => c.clear());
  update();
}
$('#resetBtn').addEventListener('click', resetFilters);

/* -------------------------------- list ------------------------------- */

function currentList() {
  let list = state.filtered;
  if (state.limitToMap) {
    const b = bounds();
    list = list.filter((it) => inBounds(it, b));
  }
  const c = map.getCenter();
  const origin = state.origin || (state.limitToMap ? { lat: c.lat, lng: c.lng } : null);
  return sortItems(list, origin);
}

function rowHtml(it) {
  const g = state.groupById.get(it.group);
  const dist = state.origin && it.lat != null ? `<span class="dist">${distanceKm(state.origin, it) < 10 ? distanceKm(state.origin, it).toFixed(1) : Math.round(distanceKm(state.origin, it))} ק״מ</span>` : '';
  const plans = it.plans.length ? `<span class="plans">${it.plans.map((p) => `<span class="plan-tag">${p}</span>`).join('')}</span>` : '';
  const tags = [...it.types, ...it.styles].slice(0, 5).join(', ');
  const where = it.address || it.city || 'כתובת לא ידועה';
  return `<li class="row" tabindex="0" data-id="${esc(it.id)}" style="--g:${g?.color || '#6B7A86'}" aria-current="${state.selectedId === it.id}">
    <h3>${esc(it.name)}</h3>
    <div class="meta">${dist}${plans}${badges(it)}</div>
    <p class="addr">${esc(where)}${it.geo === 'city' ? ' <span class="approx">· מיקום משוער</span>' : ''}</p>
    ${tags ? `<p class="tags">${esc(tags)}</p>` : ''}
  </li>`;
}

let observer;
function renderList() {
  const list = currentList();
  const total = state.filtered.length;
  const unlocated = state.limitToMap ? state.filtered.filter((i) => i.lat == null).length : 0;

  $('#listCount').innerHTML = state.limitToMap
    ? `${nf.format(list.length)} באזור המפה <span>מתוך ${nf.format(total)}</span>`
    : `${nf.format(total)} תוצאות`;

  const ol = $('#results');
  if (!total) {
    ol.innerHTML = `<li class="empty"><strong>אין מקומות שמתאימים לכל הסינונים</strong>נסו להסיר סינון אחד, למשל את העיר או את המסלול.<br><button class="btn-ghost" data-act="reset">ניקוי כל הסינונים</button></li>`;
    return;
  }
  if (!list.length) {
    ol.innerHTML = `<li class="empty"><strong>אין תוצאות באזור הזה של המפה</strong>הזיזו את המפה, או הציגו את כל ${nf.format(total)} התוצאות.${unlocated ? ` ${nf.format(unlocated)} מהן עדיין בלי מיקום על המפה.` : ''}<br><button class="btn-ghost" data-act="fit">הצגת כל התוצאות במפה</button></li>`;
    return;
  }
  const shown = list.slice(0, state.listLimit);
  let html = shown.map(rowHtml).join('');
  if (list.length > shown.length) html += '<li class="sentinel" aria-hidden="true"></li>';
  else if (unlocated) html += `<li class="empty">${nf.format(unlocated)} תוצאות נוספות עדיין בלי מיקום על המפה. כבו את „רק באזור המפה” כדי לראות אותן.</li>`;
  ol.innerHTML = html;

  observer?.disconnect();
  const s = ol.querySelector('.sentinel');
  if (s) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        state.listLimit += 80;
        renderList();
      }
    }, { root: $('#panel') });
    observer.observe(s);
  }
}

$('#results').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'reset') return resetFilters();
  if (act === 'fit') {
    if (state.limitToMap) fitResults();
    return;
  }
  const row = e.target.closest('.row');
  if (row) select(row.dataset.id);
});
$('#results').addEventListener('keydown', (e) => {
  const row = e.target.closest('.row');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    select(row.dataset.id);
  }
});

$('#limitToMap').addEventListener('change', (e) => {
  state.limitToMap = e.target.checked;
  state.listLimit = 60;
  renderList();
  saveHash();
});

map.on('moveend', () => {
  if (state.limitToMap) {
    state.listLimit = 60;
    renderList();
  }
  saveHash();
});

/* ------------------------------ selection ---------------------------- */

function restoreSelectedMarker() {
  const m = state.selectedId && markers.get(state.selectedId);
  if (m) {
    m.setIcon(iconFor(state.byId.get(state.selectedId), true));
    m.setZIndexOffset(1000);
  }
}

function setSelected(id) {
  const prev = state.selectedId && markers.get(state.selectedId);
  if (prev) {
    prev.setIcon(iconFor(state.byId.get(state.selectedId)));
    prev.setZIndexOffset(0);
  }
  state.selectedId = id;
  restoreSelectedMarker();
  document.querySelectorAll('.row[aria-current="true"]').forEach((r) => r.setAttribute('aria-current', 'false'));
  if (id) document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.setAttribute('aria-current', 'true');
}

async function select(id, { fromMap = false } = {}) {
  const it = state.byId.get(id);
  if (!it) return;
  setSelected(id);
  if (!fromMap && it.lat != null) {
    const m = markers.get(id);
    if (m && cluster.hasLayer(m)) cluster.zoomToShowLayer(m, () => map.panTo(m.getLatLng(), { animate: true }));
    else map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }
  if (fromMap) document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (isMobile()) setSheet('peek');
  await openDetail(id);
  saveHash();
}

async function openDetail(id) {
  const box = $('#detail');
  const it = state.byId.get(id);
  renderDetail(it, true);
  box.hidden = false;
  box.querySelector('.detail-close')?.focus({ preventScroll: true });
  try {
    if (!state.details.has(id)) {
      if (STATIC) {
        staticDetails ||= await (await fetch('/data/details.json')).json();
        state.details.set(id, { ...it, ...(staticDetails[id] || {}) });
      } else {
        const r = await fetch(`/api/locations/${encodeURIComponent(id)}`);
        if (r.ok) state.details.set(id, await r.json());
      }
    }
    if (state.selectedId === id && state.details.has(id)) renderDetail(state.details.get(id), false);
  } catch {
    /* keep the light version */
  }
}

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
const copyBtn = (value, what) => `<button type="button" class="copy" data-copy="${esc(value)}" data-what="${esc(what)}" aria-label="העתקת ${esc(what)}" title="העתקה">${COPY_ICON}</button>`;

function placeLink(it) {
  const p = new URLSearchParams({ sel: it.id });
  if (it.lat != null) p.set('map', `${it.lat.toFixed(5)},${it.lng.toFixed(5)},16`);
  return `${location.origin}${location.pathname}#${p}`;
}

function renderContactSection(it, loading) {
  if (loading && !it.contact) return '<section class="d-sec"><h3>יצירת קשר</h3><p class="muted">טוען פרטי קשר…</p></section>';
  const actions = contactActions(it);
  const rows = actions
    .map((a) => `<li class="c-row ${a.kind}">
        <a class="c-act ${a.kind}" href="${a.href}" ${a.kind === 'whatsapp' ? 'target="_blank" rel="noopener"' : ''}>
          <span class="c-label">${a.label}</span><span class="c-val" dir="ltr">${esc(a.value)}</span>
        </a>${copyBtn(a.copy, a.kind === 'email' ? 'כתובת המייל' : 'המספר')}
        ${a.kind === 'whatsapp' ? `<p class="c-note">${esc(a.evidence)}${a.sourceUrl ? `, ב<a href="${esc(a.sourceUrl)}" target="_blank" rel="noopener">${esc(a.source)}</a>` : ''}.</p>` : ''}
      </li>`)
    .join('');
  const hasPhone = actions.some((a) => a.kind === 'phone');
  const hasWa = actions.some((a) => a.kind === 'whatsapp');
  const waNote = !hasWa && hasPhone ? '<p class="c-note">העסק לא פרסם מספר וואטסאפ, אז אין כאן כפתור וואטסאפ.</p>' : '';
  const social = socialLinks(it);
  const socialHtml = social.length
    ? `<div class="d-tags social">${social.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${x.label}</a>`).join('')}</div>`
    : '';
  const body = rows || social.length
    ? `${rows ? `<ul class="c-list">${rows}</ul>` : ''}${waNote}${socialHtml}`
    : `<p class="muted">לא נמצאו פרטי קשר. Freefit לא מפרסם טלפונים של העסקים${it.osm ? ', וגם ברשומה של העסק ב-OpenStreetMap אין פרטי קשר' : ', והעסק לא נמצא ב-OpenStreetMap'}.</p>`;
  return `<section class="d-sec"><h3>יצירת קשר</h3>${body}</section>`;
}

/** Plain-language reason a business site could not be read for contacts. */
function siteErrorText(err = '') {
  if (/robots/.test(err)) return 'האתר מבקש מכלים אוטומטיים לא לקרוא אותו, אז פרטי הקשר נלקחו רק מדף Freefit.';
  if (/HTTP 404|HTTP 410/.test(err)) return 'הקישור לאתר הוביל לדף שלא קיים בבדיקה האחרונה.';
  if (/timeout|Timeout|abort/i.test(err)) return 'האתר לא ענה בזמן בבדיקה האחרונה.';
  return 'לא הצלחנו לפתוח את האתר בבדיקה האחרונה.';
}

function renderWebsiteSection(it, loading) {
  if (loading && !it.contact) return '';
  const w = websiteInfo(it);
  const booking = bookingInfo(it);
  const bookingHtml = booking && booking.url !== w?.url ? `<p><a href="${esc(booking.url)}" target="_blank" rel="noopener">${booking.label}</a></p>` : '';
  if (w) {
    const st = it.siteStatus;
    const note = st && !st.ok && w.kind !== 'booking' ? `<p class="c-note">${siteErrorText(st.error)}</p>` : '';
    return `<section class="d-sec"><h3>${w.label}</h3>
      <div class="site-row"><a class="action" href="${esc(w.url)}" target="_blank" rel="noopener" dir="ltr">${esc(w.host)}</a>${copyBtn(w.url, 'הקישור לאתר')}</div>${note}${bookingHtml}</section>`;
  }
  return `<section class="d-sec"><h3>אתר העסק</h3>
    <p class="muted">לא נמצא אתר בדף העסק ב-Freefit.</p>
    <p><a href="${searchUrl(it)}" target="_blank" rel="noopener">חיפוש העסק בגוגל</a></p>${bookingHtml}</section>`;
}

function renderSourcesSection(it) {
  const freefit = safeUrl(it.url);
  const parts = [];
  if (freefit) parts.push(`<li><a href="${esc(freefit)}" target="_blank" rel="noopener">הדף של העסק ב-Freefit</a>${copyBtn(freefit, 'הקישור לדף ב-Freefit')}</li>`);
  const osmUrl = safeUrl(it.osm?.url);
  if (osmUrl) parts.push(`<li><a href="${esc(osmUrl)}" target="_blank" rel="noopener">הרשומה ב-OpenStreetMap${it.osm.name ? `: ${esc(it.osm.name)}` : ''}</a></li>`);
  const st = it.siteStatus;
  if (st?.ok && safeUrl(st.finalUrl || st.url)) parts.push(`<li>אתר העסק נבדק לאיתור פרטי קשר</li>`);
  parts.push(`<li>קישור למקום הזה באפליקציה${copyBtn(placeLink(it), 'הקישור למקום')}</li>`);
  return `<section class="d-sec sources"><h3>מקורות וקישורים</h3><ul>${parts.join('')}</ul></section>`;
}

function renderDetail(it, loading) {
  const exact = it.lat != null && it.geo !== 'city';
  const dest = exact ? `${it.lat},${it.lng}` : it.address || `${it.name} ${it.city}`;
  const waze = exact ? `https://waze.com/ul?ll=${it.lat},${it.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(dest)}&navigate=yes`;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  const sec = (title, body) => (body ? `<section class="d-sec"><h3>${title}</h3>${body}</section>` : '');
  const tags = (arr) => (arr?.length ? `<div class="d-tags">${arr.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '');
  const dist = state.origin && it.lat != null ? `, ${distanceKm(state.origin, it).toFixed(1)} ק״מ ממך` : '';
  const img = safeUrl(it.image);
  const where = it.address || it.city || 'כתובת לא ידועה';

  $('#detail').innerHTML = `
    <button class="detail-close" aria-label="סגירה">${X_ICON}</button>
    ${img ? `<img class="detail-img" src="${esc(img)}" alt="" loading="lazy" />` : ''}
    <div class="detail-body">
      <h2 id="detailTitle">${esc(it.name)}</h2>
      <p class="addr"><span>${esc(where)}${dist}</span>${it.address ? copyBtn(it.address, 'הכתובת') : ''}</p>
      <div class="actions">
        <a class="action primary" href="${waze}" target="_blank" rel="noopener">ניווט ב-Waze</a>
        <a class="action" href="${gmaps}" target="_blank" rel="noopener">Google Maps</a>
      </div>
      ${it.geo === 'city' ? '<p class="approx-note">הסיכה מסמנת את מרכז העיר. הכתובת המדויקת עוד לא אותרה, אז כדאי לנווט לפי הכתובת.</p>' : ''}
      ${renderContactSection(it, loading)}
      ${renderWebsiteSection(it, loading)}
      ${sec('מסלולים שכוללים את המקום', it.plans?.length ? `<div class="d-tags">${it.plans.map((p) => `<span dir="ltr">${p}</span>`).join('')}</div>` : '')}
      ${sec('שעות פתיחה', it.hours?.length ? `<ul>${it.hours.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : loading ? '<p class="muted">טוען…</p>' : '')}
      ${sec('פעילות', tags(it.types))}
      ${sec('סגנונות אימון', tags(it.styles))}
      ${sec('מתקנים', tags(it.amenities))}
      ${sec('חשוב לדעת', it.notes ? `<p class="notes clamped">${esc(it.notes)}</p><button class="link-btn" data-act="more">הצגת הכול</button>` : '')}
      ${sec('על המקום', it.description ? `<p class="notes clamped">${esc(it.description)}</p><button class="link-btn" data-act="more">הצגת הכול</button>` : '')}
      ${renderSourcesSection(it)}
    </div>`;
  $('#detail .detail-img')?.addEventListener('error', (e) => e.target.remove());
}

/* ------------------------------- copy -------------------------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for http:// pages and older browsers.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function closeDetail() {
  $('#detail').hidden = true;
  setSelected(null);
  saveHash();
}

$('#detail').addEventListener('click', async (e) => {
  if (e.target.closest('.detail-close')) return closeDetail();
  const c = e.target.closest('[data-copy]');
  if (c) {
    const ok = await copyText(c.dataset.copy);
    toast(ok ? `הועתק: ${c.dataset.what}` : 'ההעתקה לא הצליחה. סמנו והעתיקו ידנית.');
    return;
  }
  const more = e.target.closest('[data-act="more"]');
  if (more) {
    more.previousElementSibling.classList.remove('clamped');
    more.remove();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#detail').hidden) closeDetail();
});

/* ------------------------------- search ------------------------------ */

$('#q').addEventListener('input', (e) => {
  state.f.q = e.target.value.trim();
  updateSoon();
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    update({ fit: true });
    e.target.blur();
  }
});

/* ------------------------------ map tools ---------------------------- */

$('#fitBtn').addEventListener('click', fitResults);

$('#locateBtn').addEventListener('click', () => {
  const btn = $('#locateBtn');
  if (state.origin) {
    state.origin = null;
    btn.setAttribute('aria-pressed', 'false');
    userMarker?.remove();
    userMarker = null;
    renderList();
    return;
  }
  if (!navigator.geolocation) return toast('הדפדפן לא תומך באיתור מיקום.');
  btn.setAttribute('aria-busy', 'true');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.removeAttribute('aria-busy');
      btn.setAttribute('aria-pressed', 'true');
      state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      userMarker?.remove();
      userMarker = L.circleMarker([state.origin.lat, state.origin.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1D6FD8', fillOpacity: 1 }).addTo(map);
      map.flyTo([state.origin.lat, state.origin.lng], 13, { duration: 0.8 });
      renderList();
    },
    (err) => {
      btn.removeAttribute('aria-busy');
      toast(err.code === 1 ? 'כדי למיין לפי מרחק, צריך לאשר גישה למיקום בהגדרות הדפדפן.' : 'לא הצלחנו לאתר את המיקום. נסו שוב בעוד רגע.');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
});

/* ------------------------------ URL state ---------------------------- */

let restoringHash = false;
function saveHash() {
  if (restoringHash || !state.items.length) return;
  const c = map.getCenter();
  const p = filtersToParams(state.f, {
    map: `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom()}`,
    sel: state.selectedId || '',
    all: state.limitToMap ? '' : '1',
  });
  history.replaceState(null, '', `#${p.toString()}`);
}

function restoreHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  restoringHash = true;
  state.f = paramsToFilters(p);
  $('#q').value = state.f.q;
  state.limitToMap = p.get('all') !== '1';
  $('#limitToMap').checked = state.limitToMap;
  const m = (p.get('map') || '').split(',').map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) map.setView([m[0], m[1]], m[2], { animate: false });
  restoringHash = false;
  return p.get('sel');
}

/* --------------------------- data & status --------------------------- */

async function loadData() {
  const r = await fetch(STATIC ? '/data/list.json' : '/api/locations');
  if (r.status === 503) return false;
  if (STATIC && r.ok) {
    const peek = await r.clone().json();
    if (!peek.items?.length) {
      $('#boot').hidden = false;
      $('#bootPhase').textContent = 'עוד אין נתונים באתר הזה. הריצו את איסוף הנתונים (npm run refresh או ה-GitHub Action) ופרסמו מחדש.';
      $('#bootBar').style.width = '0%';
      return false;
    }
  }
  if (!r.ok) throw new Error(`Server answered ${r.status}`);
  const data = await r.json();
  const firstLoad = !state.items.length;
  state.version = data.version;
  state.generatedAt = data.generatedAt;
  state.groups = data.groups;
  state.groupById = new Map(data.groups.map((g) => [g.id, g]));
  state.plans = data.plans;
  state.items = indexItems(data.items);
  state.byId = new Map(state.items.map((i) => [i.id, i]));
  state.amenities = [...new Set(state.items.flatMap((i) => i.amenities))].sort((a, b) => a.localeCompare(b, 'he'));
  state.details.clear();
  iconCache.clear();
  buildMarkers();
  state.filteredKey = '';

  if (firstLoad) {
    const sel = restoreHash();
    update();
    if (sel && state.byId.has(sel)) select(sel, { fromMap: !!location.hash.includes('map=') });
  } else {
    update();
  }
  $('#totalLine').textContent = `${nf.format(state.items.length)} מקומות להתאמן בהם, בכל הארץ`;
  return true;
}

let lastStatus = null;
async function pollStatus() {
  if (STATIC) {
    // No live server: describe the published snapshot instead.
    const located = state.items.filter((i) => i.lat != null).length;
    const approx = state.items.filter((i) => i.geo === 'city').length;
    $('#statusText').textContent = [
      `${nf.format(state.items.length)} מקומות`,
      `${nf.format(located)} על המפה`,
      approx ? `${nf.format(approx)} במיקום משוער` : '',
      relTime(state.generatedAt),
    ].filter(Boolean).join(', ');
    $('#refreshBtn').hidden = true;
    return;
  }
  let s;
  try {
    s = await (await fetch('/api/status')).json();
  } catch {
    $('#statusText').textContent = 'אין חיבור לשרת המקומי. ודאו שהוא עדיין רץ.';
    return setTimeout(pollStatus, 5000);
  }
  lastStatus = s;
  renderStatus(s);

  if (!state.items.length && s.count > 0) {
    await loadData();
    $('#boot').hidden = true;
  } else if (state.items.length && s.version && s.version !== state.version) {
    await loadData();
  }
  const busy = s.state === 'building' || s.state === 'geocoding';
  setTimeout(pollStatus, !state.items.length ? 1500 : busy ? 5000 : 60000);
}

function renderStatus(s) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  if (!state.items.length) {
    $('#boot').hidden = false;
    $('#bootPhase').textContent =
      s.state === 'error' ? `האיסוף נכשל: ${s.error}. בדקו את חיבור האינטרנט והריצו npm run probe לאבחון.` : `${phaseHe(s.phase)}${s.total ? ` (${nf.format(s.done)} מתוך ${nf.format(s.total)})` : ''}`;
    $('#bootBar').style.width = `${Math.max(4, pct)}%`;
    $('#bootLog').textContent = (s.log || []).join('\n');
  }
  const parts = [`${nf.format(s.count)} מקומות`];
  if (s.count) parts.push(`${nf.format(s.located)} על המפה`);
  if (s.approximate) parts.push(`${nf.format(s.approximate)} במיקום משוער`);
  parts.push(relTime(s.generatedAt));
  $('#statusText').textContent = parts.filter(Boolean).join(', ');

  const prog = $('#mapProgress');
  if (state.items.length && (s.state === 'geocoding' || s.state === 'building')) {
    prog.hidden = false;
    prog.textContent = `${phaseHe(s.phase)}: ${nf.format(s.done)} מתוך ${nf.format(s.total)}`;
  } else prog.hidden = true;

  $('#refreshBtn').disabled = s.state === 'building';
  $('#refreshBtn').textContent = s.state === 'building' ? 'מרעננים…' : 'רענון נתונים';
}

const PHASES = {
  'Reading the locations page': 'קוראים את דף המקומות',
  'Trying the WordPress API': 'בודקים את ממשק הנתונים של האתר',
  'Downloading club list (REST)': 'מורידים את רשימת המקומות',
  'Reading sitemaps': 'קוראים את מפת האתר',
  'Crawling category pages': 'עוברים על דפי הקטגוריות',
  'Reading club pages': 'קוראים את דפי המקומות',
  'Placing cities on the map': 'ממקמים ערים על המפה',
  'Pinpointing addresses': 'מאתרים כתובות מדויקות',
};
const phaseHe = (p) => PHASES[p] || p || 'מתחילים';

$('#refreshBtn').addEventListener('click', async () => {
  await fetch('/api/refresh', { method: 'POST' });
  pollStatus();
});

/* --------------------------- mobile sheet ---------------------------- */

const panel = $('#panel');
const SNAP = { peek: 0.2, half: 0.46, full: 0.9 };
function setSheet(which) {
  if (!isMobile()) return;
  panel.style.setProperty('--sheet-h', `${Math.round(window.innerHeight * SNAP[which])}px`);
  panel.dataset.sheet = which;
}
(() => {
  const handle = $('#sheetHandle');
  let startY = 0;
  let startH = 0;
  let moved = false;
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    moved = false;
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const h = Math.min(window.innerHeight * 0.95, Math.max(80, startH + (startY - e.clientY)));
    if (Math.abs(startY - e.clientY) > 4) moved = true;
    panel.style.setProperty('--sheet-h', `${h}px`);
  });
  handle.addEventListener('pointerup', () => {
    panel.classList.remove('dragging');
    const ratio = panel.getBoundingClientRect().height / window.innerHeight;
    if (!moved) return setSheet(panel.dataset.sheet === 'full' ? 'peek' : panel.dataset.sheet === 'half' ? 'full' : 'half');
    const nearest = Object.entries(SNAP).sort((a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio))[0][0];
    setSheet(nearest);
  });
})();

$('#filtersToggle').addEventListener('click', () => {
  const open = !panel.classList.contains('filters-open');
  panel.classList.toggle('filters-open', open);
  $('#filtersToggle').setAttribute('aria-expanded', open);
  if (open) setSheet('full');
});
$('#q').addEventListener('focus', () => isMobile() && panel.dataset.sheet === 'peek' && setSheet('half'));
window.addEventListener('resize', debounce(() => setSheet(panel.dataset.sheet || 'half'), 150));
setSheet('half');

/* -------------------------------- boot ------------------------------- */

(async () => {
  try {
    const ok = await loadData();
    if (ok) $('#boot').hidden = true;
  } catch (e) {
    console.error(e);
  }
  pollStatus();
})();

// Exposed for debugging in the browser console.
window.__ff = { state, map, update, select };

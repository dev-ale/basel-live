/* Basel Live – trams & buses screensaver
 * Data: transport.opendata.ch stationboards (real-time prognosis per stop) from hub stops.
 * Track geometry + official line colours: OpenStreetMap route relations (routes.json, built by build_routes.py).
 * Switzerland publishes no raw vehicle GPS feed, so each vehicle is interpolated between its last and next stop
 * along the real track, using the delay-adjusted times.
 */

const API = 'https://transport.opendata.ch/v1/stationboard';
const HUBS = [
  'Basel, Barfüsserplatz', 'Basel, Bankverein', 'Basel, Aeschenplatz', 'Basel, Marktplatz',
  'Basel, Schifflände', 'Basel, Claraplatz', 'Basel, Messeplatz', 'Basel, Bahnhof SBB',
  'Basel, Badischer Bahnhof', 'Basel, Universitätsspital', 'Basel, Heuwaage', 'Basel, Wettsteinplatz',
  'Basel, Brausebad', 'Basel, Kannenfeldplatz', 'Basel, Dreirosenbrücke', 'Basel, Theater',
  'Basel, Schützenhaus', 'Basel, Zoo Bachletten', 'Basel, Riehenring', 'Basel, Gewerbeschule',
  'Basel, Dreispitz', 'Basel, Morgartenring', 'Basel, Kleinhüningen', 'Basel, Bruderholz',
];
const POLL_MS = 40000;             // full round over all hubs
const FALLBACK_COLOURS = { '1': '#835237', '2': '#A68351', '3': '#324EA1', '6': '#0069B4', '8': '#ED6EA7', '10': '#FECA0A', '11': '#E30613',
  '12': '#9471AD', '14': '#F58220', '15': '#009640', '16': '#AFCA0B', '17': '#00AEEF', '21': '#00A295' };

import * as maplibregl from 'maplibre-gl';
import { vehicleLayer, drawVehicles, vehicleType, loadModels, setDaylight } from './vehicles3d.js';

/* ---------- map ---------- */
const ZOOM_3D = 16;   // from here vehicles are 3D models (a tram is ~60 px long); below it, 2D badges
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', center: [7.59, 47.556], zoom: 13,
  maxPitch: 75, hash: true, attributionControl: false });
// credits for any glTF vehicle models (models/manifest.json) join the map attribution
loadModels().then(credits => map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ['transport.opendata.ch', ...credits] })));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
const mapReady = new Promise(r => map.on('load', r));

/* ---------- state ---------- */
const journeys = new Map();   // key -> { key, line, cat, to, op, stops:[{id,name,lat,lon,arr,dep,delay}], marker, popup, lastSeen }
const stops = new Map();      // id -> { id, name, lat, lon, hub }
let stopsDirty = false;       // stop source is re-uploaded from the render loop, not once per added stop
const routes = {};            // line -> { colour, graph }
const ALL_TRAMS = '*tram', ALL_BUSES = '*bus';   // routes keys for the merged network graphs
const pathCache = new Map();  // `${line}|${a}|${b}` -> [[lat,lon],...] or null

const $ = id => document.getElementById(id);
const ts = s => s ? Date.parse(s) : null;
const short = n => (n || '').replace(/^Basel, /, '');
const TRAM_LINES = /^(1|2|3|6|8|10|11|12|14|15|16|17|21|E11)$/;
const colourFor = n => routes[n]?.colour || FALLBACK_COLOURS[n] || (TRAM_LINES.test(n) ? `hsl(${[...n].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360} 60% 50%)` : '#8a8f99');
const textOn = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff'; const v = parseInt(m[1], 16); const l = .299 * (v >> 16) + .587 * ((v >> 8) & 255) + .114 * (v & 255); return l > 165 ? '#1a1a1a' : '#fff'; };

/* ---------- track graph (per line) ---------- */
// nodes keyed by rounded lat/lon; edges with metric length. Shortest path between the nodes nearest two stops.
const R = 6371000, toRad = d => d * Math.PI / 180;
function haversine(a, b) { const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }
function buildGraph(segments) {
  const nodes = new Map(); // key -> {p:[lat,lon], adj: Map(key -> dist)}
  const key = p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const get = p => { const k = key(p); let n = nodes.get(k); if (!n) { n = { p, adj: new Map() }; nodes.set(k, n); } return n; };
  for (const seg of segments) for (let i = 1; i < seg.length; i++) {
    const a = get(seg[i - 1]), b = get(seg[i]); const d = haversine(a.p, b.p);
    a.adj.set(key(b.p), d); b.adj.set(key(a.p), d);
  }
  return { nodes, key };
}
// binary min-heap of [priority, value]
function heap() {
  const a = [];
  return {
    size: () => a.length,
    push(x) { a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    },
  };
}
// candidate nodes for a stop: every node within 40 m (both directions' tracks), else the nearest one within 120 m
function nodesNear(g, p) {
  const near = []; let best = null, bd = Infinity;
  for (const [k, n] of g.nodes) { const m = haversine(n.p, p); if (m < 40) near.push([m, k]); if (m < bd) { bd = m; best = k; } }
  return near.length ? near : bd < 120 ? [[bd, best]] : [];
}
// multi-source Dijkstra: shortest track from any start candidate to any target candidate.
// Each direction is often its own parallel way, joined only at the termini; a single nearest node could sit on the
// wrong one and send the path to the end of the line and back.
function shortestPath(g, starts, targets) {
  const dist = new Map(), prev = new Map(), open = heap(), done = new Set(); let end = null;
  for (const [d, k] of starts) { dist.set(k, d); open.push([d, k]); }
  while (open.size()) {
    const [d, k] = open.pop();
    if (done.has(k)) continue; done.add(k);
    if (targets.has(k)) { end = k; break; }
    for (const [nk, w] of g.nodes.get(k).adj) { const nd = d + w; if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); prev.set(nk, k); open.push([nd, nk]); } }
  }
  if (end == null) return null;
  const path = []; for (let k = end; k; k = prev.get(k)) path.unshift(g.nodes.get(k).p);
  return path;
}
function trackBetween(line, a, b) {
  const ck = `${line}|${a.id}|${b.id}`;
  if (pathCache.has(ck)) return pathCache.get(ck);
  // the line's own track first; diversions leave it, so then any tram (or bus) line's track
  const path = routeVia(routes[line]?.graph, a, b) || routeVia(routes[TRAM_LINES.test(line) ? ALL_TRAMS : ALL_BUSES]?.graph, a, b)
    || [[a.lat, a.lon], [b.lat, b.lon]];
  const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
  const out = { path, cum, len: cum[cum.length - 1] };
  pathCache.set(ck, out); return out;
}
function routeVia(g, a, b) {
  if (!g) return null;
  const na = nodesNear(g, [a.lat, a.lon]), nb = nodesNear(g, [b.lat, b.lon]);
  if (!na.length || !nb.length) return null;
  const p = shortestPath(g, na, new Set(nb.map(([, k]) => k)));
  return p && pathLength(p) < haversine([a.lat, a.lon], [b.lat, b.lon]) * 2.5 + 200 ? [[a.lat, a.lon], ...p, [b.lat, b.lon]] : null;
}
const pathLength = p => { let l = 0; for (let i = 1; i < p.length; i++) l += haversine(p[i - 1], p[i]); return l; };
function along(track, t) {
  const d = t * track.len; const { path, cum } = track;
  let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const s = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * s, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * s];
}

async function loadRoutes() {
  try {
    const res = await fetch('routes.json'); if (!res.ok) throw 0;
    const data = await res.json();
    const features = [], all = { tram: [], bus: [] };
    for (const [line, r] of Object.entries(data.lines)) {
      routes[line] = { colour: r.colour, graph: buildGraph(r.segments) };
      all[TRAM_LINES.test(line) ? 'tram' : 'bus'].push(...r.segments);
      const tram = TRAM_LINES.test(line), colour = r.colour || colourFor(line);
      for (const seg of r.segments) features.push({ type: 'Feature', properties: { colour, tram }, geometry: { type: 'LineString', coordinates: seg.map(([lat, lon]) => [lon, lat]) } });
    }
    routes[ALL_TRAMS] = { graph: buildGraph(all.tram) }; routes[ALL_BUSES] = { graph: buildGraph(all.bus) };
    map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['case', ['get', 'tram'], 1, 0] },
      paint: { 'line-color': ['get', 'colour'], 'line-width': ['case', ['get', 'tram'], 3, 1.5], 'line-opacity': ['case', ['get', 'tram'], .55, .3] } }, 'stops');
    const legend = $('legend');
    for (const line of Object.keys(data.lines).filter(l => TRAM_LINES.test(l)).sort((a, b) => (parseInt(a) || 999) - (parseInt(b) || 999)))
      legend.insertAdjacentHTML('beforeend', `<span class="chip" style="background:${colourFor(line)};color:${textOn(colourFor(line))}">${line}</span>`);
    legend.insertAdjacentHTML('beforeend', `<span class="chip bus" style="background:#8a8f99">bus</span>`);
  } catch { $('status').textContent = 'routes.json missing – drawing straight lines between stops'; }
}

/* ---------- helpers ---------- */
function stopTimes(p) {
  const d = (p.delay || 0) * 60000;
  const arr = ts(p.prognosis?.arrival) ?? (ts(p.arrival) != null ? ts(p.arrival) + d : null);
  const dep = ts(p.prognosis?.departure) ?? (ts(p.departure) != null ? ts(p.departure) + d : null);
  return { arr: arr ?? dep, dep: dep ?? arr };
}

/* ---------- data ingest ---------- */
async function fetchHub(name) {
  const res = await fetch(`${API}?station=${encodeURIComponent(name)}&limit=40`);
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  const hub = data.station; const now = Date.now();
  for (const j of data.stationboard || []) {
    if (!['T', 'B', 'NFB'].includes((j.category || '').toUpperCase())) continue;
    const key = `${j.number}|${j.name}|${j.to}`;
    const list = [];
    for (const p of j.passList || []) {
      const st = p.station || {};
      let lat = st.coordinate?.x, lon = st.coordinate?.y, id = st.id, nm = st.name;
      if (!lat && id === hub.id) { lat = hub.coordinate.x; lon = hub.coordinate.y; nm = hub.name; }
      if (!lat || !lon) continue;
      const { arr, dep } = stopTimes(p);
      if (arr == null && dep == null) continue;
      list.push({ id, name: nm, lat, lon, arr, dep, delay: p.delay });
      if (id && !stops.has(id)) addStop({ id, name: nm, lat, lon, hub: id === hub.id });
    }
    if (list.length < 2) continue;
    const cat = j.category === 'T' ? 'tram' : 'bus';
    const existing = journeys.get(key);
    if (!existing) journeys.set(key, { key, line: j.number, cat, to: j.to, op: j.operator, stops: list, lastSeen: now });
    else {
      if (list[0].dep < existing.stops[0].dep || list.length > existing.stops.length) existing.stops = list;
      else for (const s of list) { const e = existing.stops.find(x => x.id === s.id); if (e) Object.assign(e, s); }
      existing.lastSeen = now;
    }
  }
}

function addStop(s) {
  stops.set(s.id, s); stopsDirty = true; $('nStops').textContent = stops.size;
}
const stopsGeoJSON = () => ({ type: 'FeatureCollection', features: [...stops.values()].map(s => ({ type: 'Feature', properties: { id: s.id, name: short(s.name), hub: !!s.hub }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) });

function setupStopLayer() {
  map.addSource('stops', { type: 'geojson', data: stopsGeoJSON(), promoteId: 'id' });
  const hover = ['boolean', ['feature-state', 'hover'], false];
  map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: {
    'circle-radius': ['*', ['case', ['get', 'hub'], 4, 2.5], ['case', hover, 1.6, 1]],
    'circle-color': '#e8ecf3', 'circle-stroke-color': '#2a3140', 'circle-stroke-width': 2 } });
  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'tip' });
  let hovered = null;
  const setHover = id => { if (hovered != null) map.setFeatureState({ source: 'stops', id: hovered }, { hover: false }); hovered = id; if (id != null) map.setFeatureState({ source: 'stops', id }, { hover: true }); };
  map.on('mousemove', 'stops', e => {
    const f = e.features[0]; map.getCanvas().style.cursor = 'pointer';
    if (f.id !== hovered) { setHover(f.id); tip.setLngLat(f.geometry.coordinates).setText(f.properties.name).addTo(map); }
  });
  map.on('mouseleave', 'stops', () => { map.getCanvas().style.cursor = ''; setHover(null); tip.remove(); });
  map.on('click', 'stops', e => {
    if (e.originalEvent.target.closest('.veh')) return;   // vehicle badges sit above stops: their own popup wins
    const s = stops.get(e.features[0].properties.id); if (!s) return;
    tip.remove();
    const popup = new maplibregl.Popup({ maxWidth: '320px', offset: 8 }).setLngLat([s.lon, s.lat])
      .setHTML(`<div class="popup"><h3>${short(s.name)}<br><small>loading departures…</small></h3></div>`).addTo(map);
    showDepartures(s, popup);
  });
}

async function showDepartures(s, popup) {
  const render = rows => popup.setHTML(`<div class="popup"><h3>${short(s.name)}<br><small>next departures · live</small></h3>${rows || '<div class="muted">No departures found</div>'}</div>`);
  try {
    const res = await fetch(`${API}?id=${s.id}&limit=8`); const data = await res.json();
    const now = Date.now();
    const rows = (data.stationboard || []).map(j => {
      const { dep } = stopTimes(j.stop); const mins = Math.max(0, Math.round((dep - now) / 60000)); const d = j.stop.delay || 0;
      const c = colourFor(j.number);
      return `<div class="dep"><span class="chip ${j.category === 'T' ? '' : 'bus'}" style="background:${c};color:${textOn(c)}">${j.number}</span>
        <span class="to">${short(j.to)}</span>
        <span class="when">${mins === 0 ? 'now' : `${mins}′`}<small class="${d > 0 ? 'late' : 'ontime'}">${d > 0 ? `+${d} min` : 'on time'}</small></span></div>`;
    }).join('');
    render(rows);
  } catch (e) { render(`<div class="muted">Could not load departures (${e.message})</div>`); }
}

/* ---------- preferred source: server.py (GTFS + GTFS-RT) ---------- */
async function pollServer() {
  const res = await fetch('vehicles.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  const now = Date.now(), seen = new Set();
  for (const v of data.vehicles) {
    seen.add(v.key);
    for (const s of v.stops) if (s.id && !stops.has(s.id)) addStop({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
    const ex = journeys.get(v.key);
    if (ex) { ex.stops = v.stops; ex.rt = v.rt; ex.lastSeen = now; }
    else journeys.set(v.key, { ...v, lastSeen: now });
  }
  for (const [k, j] of journeys) if (!seen.has(k)) { removeVehicle(j); journeys.delete(k); }
  const rt = data.rt_error ? `RT error: ${data.rt_error}` : `GTFS-RT ${data.rt_age ?? '?'}s old`;
  $('status').className = data.rt_error ? 'err' : ''; $('status').textContent = `Live · ${rt} · ${new Date().toLocaleTimeString()}`;
}

async function pollLoop() {
  // try the GTFS server first; fall back to stationboard polling when running as plain static files
  try {
    const st = await fetch('stops.json', { cache: 'no-store' });
    if (st.ok) for (const s of await st.json()) if (!stops.has(s.id)) addStop(s);
    await pollServer();
    const tick = async () => { try { await pollServer(); } catch (e) { $('status').className = 'err'; $('status').textContent = `server: ${e.message}`; } setTimeout(tick, 10000); };
    setTimeout(tick, 10000); return;
  } catch { $('status').textContent = 'No server – using stationboards'; }

  await Promise.allSettled(HUBS.map(fetchHub));
  let i = 0;
  const step = async () => {
    const hub = HUBS[i++ % HUBS.length];
    try { await fetchHub(hub); $('status').className = ''; $('status').textContent = `Live · ${short(hub)} updated ${new Date().toLocaleTimeString()}`; }
    catch (e) { $('status').className = 'err'; $('status').textContent = `API error at ${short(hub)}: ${e.message}`; }
    setTimeout(step, POLL_MS / HUBS.length);
  };
  step();
}

/* ---------- interpolation ---------- */
function positionOf(j, now) {
  const s = j.stops;
  if (now > s[s.length - 1].arr + 60000) return null;
  // not yet reached the first stop we know about: only show it once it is about to arrive there
  // k/d: the track between stops k and k+1, and the distance along it in metres (for laying out 3D sections)
  if (now < s[0].arr) return now > s[0].arr - 90000 ? { ll: [s[0].lat, s[0].lon], approach: true, next: s[0], k: 0, d: 0 } : null;
  for (let k = 0; k < s.length; k++) {
    const a = s[k], b = s[k + 1];
    if (now <= a.dep || !b) return { ll: [a.lat, a.lon], at: a, next: b, dwell: true, k: b ? k : k - 1, d: b ? 0 : trackBetween(j.line, s[k - 1], a).len };
    if (now < b.arr) {
      const t = (now - a.dep) / Math.max(1, b.arr - a.dep), track = trackBetween(j.line, a, b);
      return { ll: along(track, t), prev: a, next: b, t, k, d: t * track.len };
    }
  }
  return null;
}

// point d metres along the journey's track from stop k (d may run into the neighbouring stop pairs, or past either end)
function pointAt(j, k, d) {
  const s = j.stops, seg = i => trackBetween(j.line, s[i], s[i + 1]);
  let tr = seg(k);
  while (d < 0 && k > 0) { k--; tr = seg(k); d += tr.len; }
  while (d > tr.len && k < s.length - 2) { d -= tr.len; k++; tr = seg(k); }
  if (d >= 0 && d <= tr.len) return along(tr, tr.len ? d / tr.len : 0);
  // off the known track: carry on straight along the last 5 m
  const end = d < 0 ? 0 : 1, p = along(tr, end), q = along(tr, tr.len ? Math.abs(end - Math.min(1, 5 / tr.len)) : end);
  const over = d < 0 ? -d : d - tr.len, m = haversine(p, q) || 1;
  return [p[0] + (p[0] - q[0]) / m * over, p[1] + (p[1] - q[1]) / m * over];
}

// marker element is a plain wrapper (MapLibre owns its transform); the badge inside carries the classes and zoom scaling
function addVehicle(j, p, cls) {
  const el = document.createElement('div'), badge = el.appendChild(document.createElement('div')), c = colourFor(j.line);
  badge.style.background = c; badge.style.color = textOn(c); badge.textContent = j.line;
  j.badge = badge; setVehicleClass(j, cls);
  j.popup = new maplibregl.Popup({ offset: 16, maxWidth: '320px' });
  j.popup.on('open', () => { j.popup.setHTML(popupFor(j)); j.popupAt = Date.now(); });   // on() returns a subscription in MapLibre 6, not the popup
  j.marker = new maplibregl.Marker({ element: el }).setLngLat([p.ll[1], p.ll[0]]).setPopup(j.popup).addTo(map);
}
function setVehicleClass(j, cls) { j.badge.className = `veh ${j.cat} ${cls}`; j.cls = cls; }
function removeVehicle(j) { if (j.marker) { j.popup.remove(); j.marker.remove(); j.marker = null; } }
// 3D layout: p is the vehicle's centre; sections run back from the front, each as [front, rear] on the track
function vehicle3d(j, p, late) {
  const type = vehicleType(j); let d = p.d + type.sections.reduce((a, b) => a + b, 0) / 2;
  const ends = type.sections.map(len => [pointAt(j, p.k, d), pointAt(j, p.k, d -= len)]);
  return { type, ends, op: j.op, colour: colourFor(j.line), late, dwell: p.dwell, approach: p.approach || j.rt === false };
}

function popupFor(j) {
  const p = positionOf(j, Date.now()); const nxt = p?.next; const d = nxt?.delay ?? 0;
  return `<div class="popup"><h3>${j.cat === 'tram' ? 'Tram' : 'Bus'} ${j.line} → ${short(j.to)}<br><small>${j.op} · <span class="${d > 0 ? 'late' : 'ontime'}">${d > 0 ? `+${d} min late` : 'on time'}</span>${j.rt === false ? ' · scheduled, no live data' : ''}</small></h3>
    <div class="muted">${p?.dwell ? 'At' : 'Next'}: ${short(p?.dwell ? p.at.name : nxt?.name)}${nxt && !p.dwell ? ` · ${Math.max(0, Math.round((nxt.arr - Date.now()) / 1000))}s` : ''}</div></div>`;
}

let drawn3D = false;
function render() {
  const now = Date.now(); let n = 0, late = 0;
  const in3D = map.getZoom() >= ZOOM_3D, items = [], b = in3D && map.getBounds(), pad = .002;
  const inView = ll => ll[0] > b.getSouth() - pad && ll[0] < b.getNorth() + pad && ll[1] > b.getWest() - pad && ll[1] < b.getEast() + pad;
  const live = [], queues = new Map();
  for (const [key, j] of journeys) {
    const p = positionOf(j, now);
    if (!p || now - j.lastSeen > 4 * 60000) { removeVehicle(j); journeys.delete(key); continue; }
    live.push([j, p]);
    if (p.dwell && p.next) { const q = `${p.at.id}|${p.next.id}`; if (!queues.has(q)) queues.set(q, []); queues.get(q).push([j, p]); }
  }
  // vehicles waiting at the same stop in the same direction queue up behind the first arrival instead of overlapping
  for (const q of queues.values()) if (q.length > 1) {
    q.sort((x, y) => x[1].at.arr - y[1].at.arr); let back = 0;
    for (const [j, p] of q) { if (back) { p.d -= back; p.ll = pointAt(j, p.k, p.d); } back += vehicleType(j).sections.reduce((a, b) => a + b, 0) + 3; }
  }
  for (const [j, p] of live) {
    n++;
    const isLate = (p.next?.delay ?? 0) >= 2; if (isLate) late++;
    const cls = `${isLate ? 'late' : ''} ${p.approach || j.rt === false ? 'approach' : ''} ${p.dwell ? 'dwell' : ''}`;
    if (!j.marker) addVehicle(j, p, cls);
    else {
      j.marker.setLngLat([p.ll[1], p.ll[0]]);
      if (j.cls !== cls) setVehicleClass(j, cls);
      if (j.popup.isOpen() && now - (j.popupAt || 0) > 1000) { j.popup.setHTML(popupFor(j)); j.popupAt = now; }
    }
    if (in3D && inView(p.ll)) items.push(vehicle3d(j, p, isLate));
  }
  if (in3D || drawn3D) { drawVehicles(items, now); drawn3D = in3D; map.triggerRepaint(); }
  $('nVeh').textContent = n; $('nLate').textContent = late;
  if (stopsDirty && map.getSource('stops')) { map.getSource('stops').setData(stopsGeoJSON()); stopsDirty = false; }
  requestAnimationFrame(render);
}

/* markers shrink when zoomed out so meeting trams don't pile up */
// MapLibre zoom = Leaflet zoom − 1 (512 px tiles): far was Leaflet ≤ 13, mid was Leaflet 14
const applyZoomClass = () => { const z = map.getZoom(), c = document.body.classList; c.toggle('z-far', z < 12.5); c.toggle('z-mid', z >= 12.5 && z < 13.5); c.toggle('z3d', z >= ZOOM_3D);
  // in 3D the label floats just above the roof: ~3.6 m tall, seen at the current pitch
  const mPerPx = 2 * Math.PI * 6378137 * Math.cos(map.getCenter().lat * Math.PI / 180) / (512 * 2 ** z);
  document.body.style.setProperty('--lift', `${-Math.round(10 + 3.6 * Math.sin(map.getPitch() * Math.PI / 180) / mPerPx)}px`); };
map.on('zoom', applyZoomClass); map.on('pitch', applyZoomClass); applyZoomClass();

/* ---------- screensaver chrome ---------- */
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
setInterval(() => setDaylight(new Date()), 60000);
let idleT; const wake = () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 20000); };
['mousemove', 'keydown', 'touchstart', 'click'].forEach(e => window.addEventListener(e, wake)); wake();

window.baselLive = { map, journeys, positionOf, trackBetween, routes };   // console handle for debugging

/* ---------- go ---------- */
mapReady.then(() => { setupStopLayer(); return loadRoutes(); }).then(() => { map.addLayer(vehicleLayer); return pollLoop(); });
requestAnimationFrame(render);

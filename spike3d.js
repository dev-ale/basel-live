/* Basel Live – Phase 0 spike: MapLibre + three.js
 * One articulated tram (Flexity-long dimensions, 42.8 m) drives along the real line 6 track at Barfüsserplatz.
 * Checks, shown live in the HUD:
 *   scale   – metres in the model vs metres on the map (haversine), measured in screen pixels
 *   heading – angle between the cab's axis and the track chord it sits on, in screen space
 *   jitter  – how far the GPU's float32 maths puts the cab from the exact float64 position, in pixels,
 *             for the local-origin setup used here and for the naive "objects in mercator units" setup
 */
import * as THREE from 'three';
import * as maplibregl from 'maplibre-gl';

const BARFI = [7.58885, 47.55495];   // lon, lat
const SECTIONS = [9.4, 7.8, 8.4, 7.8, 9.4], GAP = 0.25;   // body module lengths (m), bellows between them
const SPEED = 6;                     // m/s
const $ = id => document.getElementById(id);

/* ---------- geometry helpers (same maths as app.js) ---------- */
const R = 6371000, toRad = d => d * Math.PI / 180;
function haversine(a, b) { const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }
const mPerPx = z => 2 * Math.PI * 6378137 * Math.cos(toRad(BARFI[1])) / (512 * 2 ** z);   // 512 px tiles
function makeTrack(path) { const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i])); return { path, cum, len: cum[cum.length - 1] }; }
function at(track, d) {
  const { path, cum } = track; d = Math.max(0, Math.min(track.len, d));
  let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const s = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * s, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * s];
}
function slice(track, d0, d1) { const out = [at(track, d0)]; for (let i = 0; i < track.path.length; i++) if (track.cum[i] > d0 && track.cum[i] < d1) out.push(track.path[i]); out.push(at(track, d1)); return out; }

/* ---------- local frame: metres east/north/up around Barfüsserplatz ---------- */
const ORIGIN = maplibregl.MercatorCoordinate.fromLngLat(BARFI, 0);
const S = ORIGIN.meterInMercatorCoordinateUnits();
// ORIGIN_M maps local metres (east, south, up after the world group's flip) to mercator units
const ORIGIN_M = new THREE.Matrix4().makeTranslation(ORIGIN.x, ORIGIN.y, ORIGIN.z).scale(new THREE.Vector3(S, S, S));
const NAIVE_M = new THREE.Matrix4().makeTranslation(ORIGIN.x, ORIGIN.y, ORIGIN.z).scale(new THREE.Vector3(S, -S, S));
const FLIP = new THREE.Matrix4().makeScale(1, -1, 1);   // north-up local frame -> mercator's south-down y
function local(ll) { const m = maplibregl.MercatorCoordinate.fromLngLat(ll, 0); return [(m.x - ORIGIN.x) / S, -(m.y - ORIGIN.y) / S]; }

/* ---------- tram model (placeholder, built along +x = forward) ---------- */
const mat = {
  body: new THREE.MeshStandardMaterial({ color: 0x1f8a4c, roughness: .45, metalness: .25 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0c1720, roughness: .12, metalness: .7 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: .6 }),
  skirt: new THREE.MeshStandardMaterial({ color: 0x1d2329, roughness: .8 }),
  head: new THREE.MeshBasicMaterial({ color: 0xfff6d8 }),
  tail: new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
};
function box(w, d, h, m, x, y, z) { const o = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m); o.position.set(x, y, z); return o; }
function buildSection(len, cab) {
  const g = new THREE.Group(), L = len - GAP;
  g.add(box(L, 2.3, .45, mat.skirt, 0, 0, .55));                 // underframe
  g.add(box(L, 2.3, 2.15, mat.body, 0, 0, 1.85));                // body
  g.add(box(L - .7, 2.32, 1.05, mat.glass, 0, 0, 2.05));         // window band
  g.add(box(L - .4, 2.0, .35, mat.roof, 0, 0, 3.1));             // roof equipment fairing
  if (cab) {                                                       // cab at +x: windscreen + headlights; tail lights at the rear cab
    const s = cab === 'front' ? 1 : -1;
    g.add(box(.08, 2.1, 1.25, mat.glass, s * (L / 2 + .02), 0, 2.05));
    for (const y of [-.8, .8]) g.add(box(.06, .28, .14, s > 0 ? mat.head : mat.tail, s * (L / 2 + .03), y, 1.05));
  }
  return g;
}

/* ---------- state ---------- */
let track = null, dFront = 45, dir = 1, driving = true, follow = false, naive = false, last = performance.now();
const world = new THREE.Group(); world.matrixAutoUpdate = false;
const sections = SECTIONS.map((len, i) => { const g = buildSection(len, i === 0 ? 'front' : i === SECTIONS.length - 1 ? 'rear' : null); g.userData.len = len; world.add(g); return g; });
const errHist = { local: [], naive: [] };

function placeTram() {
  let d = dFront; const ends = [];
  for (const g of sections) {
    const a = at(track, d), b = at(track, d - g.userData.len), la = local(a), lb = local(b);
    g.position.set((la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2, 0);
    g.rotation.set(0, 0, Math.atan2(la[1] - lb[1], la[0] - lb[0]));
    ends.push([a, b]); d -= g.userData.len;
  }
  return ends;
}

/* ---------- float32 emulation of what the vertex shader computes ---------- */
const f32 = m => Array.from(m.elements, Math.fround);
function mul(M, v, r) {   // column-major 4x4 * vec4, every product and sum rounded with r
  const o = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) { let acc = 0; for (let c = 0; c < 4; c++) acc = r(acc + r(M[c * 4 + row] * v[c])); o[row] = acc; }
  return o;
}
const id = x => x;
function toScreen(clip) { const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight; return [(clip[0] / clip[3] + 1) / 2 * w, (1 - clip[1] / clip[3]) / 2 * h]; }
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function measure(main) {
  const cab = sections[0]; cab.updateMatrixWorld(true); world.updateMatrixWorld(true);
  const objLocal = new THREE.Matrix4().multiplyMatrices(FLIP, cab.matrix);           // object -> local metres (mercator-oriented)
  const exactM = new THREE.Matrix4().multiplyMatrices(main, ORIGIN_M).multiply(objLocal);
  const half = cab.userData.len / 2, front = [half, 0, 0, 1], rear = [-half, 0, 0, 1];
  const pFront = toScreen(mul(exactM.elements, front, id)), pRear = toScreen(mul(exactM.elements, rear, id));
  // map's own view of the same two track points
  const [a, b] = placeEnds[0], mA = map.project(a), mB = map.project(b);
  const modelPxPerM = dist2(pFront, pRear) / cab.userData.len, mapPxPerM = dist2([mA.x, mA.y], [mB.x, mB.y]) / haversine(a, b);
  const angM = Math.atan2(pFront[1] - pRear[1], pFront[0] - pRear[0]), angT = Math.atan2(mA.y - mB.y, mA.x - mB.x);
  const head = Math.abs(((angM - angT) * 180 / Math.PI + 540) % 360 - 180);
  // float32 paths: local origin = (main * origin) folded in f64, small object matrix; naive = main alone, object matrix carries mercator coords
  const pLocal = toScreen(mul(f32(new THREE.Matrix4().multiplyMatrices(main, ORIGIN_M)), mul(f32(objLocal), front.map(Math.fround), Math.fround), Math.fround));
  const naiveObj = new THREE.Matrix4().multiplyMatrices(NAIVE_M, cab.matrix);
  const pNaive = toScreen(mul(f32(main), mul(f32(naiveObj), front.map(Math.fround), Math.fround), Math.fround));
  const now = performance.now();
  for (const [k, p] of [['local', pLocal], ['naive', pNaive]]) { errHist[k].push([now, dist2(p, pFront)]); while (errHist[k][0][0] < now - 3000) errHist[k].shift(); }
  return { scale: modelPxPerM / mapPxPerM, head };
}

/* ---------- map + custom layer ---------- */
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', center: BARFI, zoom: 19, pitch: 60, bearing: -30, maxPitch: 85, maxZoom: 22, canvasContextAttributes: { antialias: true } });
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

let placeEnds = null, metrics = null;
const tramLayer = {
  id: 'tram3d', type: 'custom', renderingMode: '3d',
  onAdd(m, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(world);
    world.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(-60, 90, 140); world.add(sun, sun.target);
    this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  },
  render(gl, args) {
    if (!placeEnds) return;
    const main = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
    // local: camera = main * origin (f64), world only flips y.  naive: camera = main, world carries the mercator transform.
    world.matrix.copy(naive ? NAIVE_M : FLIP);
    this.camera.projectionMatrix.copy(naive ? main : main.clone().multiply(ORIGIN_M));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    metrics = measure(main);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  },
};

map.on('load', async () => {
  const data = await (await fetch('routes.json')).json();
  // the line 6 segment passing closest to Barfüsserplatz (routes.json stores [lat, lon])
  const segs = data.lines['6'].segments.filter(s => s.length > 20).map(s => s.map(([la, lo]) => [lo, la]));
  const best = segs.reduce((b, s) => { const d = Math.min(...s.map(p => haversine(p, BARFI))); return d < b.d ? { s, d } : b; }, { d: Infinity });
  track = makeTrack(best.s);
  console.log(`track: ${best.s.length} points, ${track.len.toFixed(0)} m, ${best.d.toFixed(0)} m from Barfüsserplatz`);
  map.addSource('track', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: track.path } } });
  map.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-color': '#0069B4', 'line-width': 2, 'line-opacity': .8 } });
  map.addSource('ruler', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // footprint the tram should cover exactly: 2.3 m wide band along the track, drawn by MapLibre itself
  map.addLayer({ id: 'ruler', type: 'line', source: 'ruler', paint: { 'line-color': '#ffd400', 'line-opacity': .55, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, 2.3 / mPerPx(15), 22, 2.3 / mPerPx(22)] } });
  map.addLayer(tramLayer);
  // start with the cab closest to Barfüsserplatz, in view
  dFront = track.cum[best.s.reduce((bi, p, i) => haversine(p, BARFI) < haversine(best.s[bi], BARFI) ? i : bi, 0)] + 30;
  map.jumpTo({ center: at(track, dFront - 21) });
  requestAnimationFrame(tick);
});

function tick(now) {
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  if (driving) {
    dFront += SPEED * dt * dir;
    if (dFront > track.len - 2) { track = makeTrack([...track.path].reverse()); dFront = 45; follow || map.easeTo({ center: at(track, 24), duration: 600 }); }   // turn back at the segment end
  }
  placeEnds = placeTram();
  const len = SECTIONS.reduce((a, b) => a + b, 0);
  map.getSource('ruler').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: slice(track, dFront - len, dFront) } });
  if (follow) map.jumpTo({ center: at(track, dFront - len / 2) });
  map.triggerRepaint();
  if (metrics) {
    const max = k => Math.max(...errHist[k].map(e => e[1]));
    const sc = metrics.scale, local = max('local'), nv = max('naive');
    $('mScale').innerHTML = `<span class="${Math.abs(sc - 1) < .005 ? 'ok' : 'bad'}">${sc.toFixed(4)}</span>`;
    $('mHead').innerHTML = `<span class="${metrics.head < .5 ? 'ok' : 'bad'}">${metrics.head.toFixed(3)}°</span>`;
    $('mLocal').innerHTML = `<span class="${local < .5 ? 'ok' : 'bad'}">${local.toFixed(3)} px</span>`;
    $('mNaive').innerHTML = `<span class="${nv < .5 ? 'ok' : 'bad'}">${nv.toFixed(2)} px</span>`;
    $('mCam').textContent = `zoom ${map.getZoom().toFixed(1)} · pitch ${map.getPitch().toFixed(0)}° · ${(mPerPx(map.getZoom()) * 100).toFixed(1)} cm/px at centre · max over 3 s`;
  }
  requestAnimationFrame(tick);
}

/* ---------- controls ---------- */
const toggle = (b, v) => { b.classList.toggle('on', v); return v; };
$('bPlay').onclick = e => { driving = toggle(e.target, !driving); };
$('bFollow').onclick = e => { follow = toggle(e.target, !follow); };
$('bNaive').onclick = e => { naive = toggle(e.target, !naive); };
const CAMS = { top: { zoom: 17, pitch: 0 }, street: { zoom: 19, pitch: 60 }, close: { zoom: 21, pitch: 72 } };
document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => map.jumpTo({ ...CAMS[b.dataset.cam], center: at(track, dFront - 21) }));   // jump: Follow's per-frame jumpTo would cancel an ease
window.spike = { map, metrics: () => metrics, errHist };

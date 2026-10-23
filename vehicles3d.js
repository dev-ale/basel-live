/* Basel Live – 3D vehicles
 * A MapLibre custom layer drawn with three.js. Every vehicle is a chain of rigid body sections laid along the track,
 * so articulated trams bend through curves. Each section shape of each vehicle type is built once (procedurally, or
 * from a glTF listed in models/manifest.json) and drawn as InstancedMeshes for the whole fleet.
 * Positions are metres around Barfüsserplatz; the origin is folded into the camera matrix in float64 (see spike3d.js),
 * which keeps float32 error far below a pixel at street zoom.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as maplibregl from 'maplibre-gl';

/* ---------- fleet: approximate Basel dimensions ---------- */
// GTFS does not say which vehicle runs a trip, so the type is a stable guess per trip, weighted by fleet size.
// Basel trams are single-ended (turning loops): one cab at the front, doors on the right only.
const TYPES = {
  flexityLong:  { sections: [9.4, 7.8, 8.4, 7.8, 9.4], width: 2.3, height: 3.45 },          // BVB Be 6/8 Flexity, 42.8 m
  flexityShort: { sections: [10.9, 10.0, 10.9], width: 2.3, height: 3.45 },                 // BVB Be 4/6 Flexity, 31.8 m
  combino:      { sections: [7.6, 4.4, 6.8, 4.4, 6.8, 4.4, 7.6], width: 2.3, height: 3.4 },  // BVB Be 6/8 Combino, 42 m
  tango:        { sections: [9.6, 8.6, 8.6, 8.6, 9.6], width: 2.4, height: 3.5 },           // BLT Be 6/10 Tango, 45 m
  tina:         { sections: [9.0, 8.7, 8.6, 8.7, 9.0], width: 2.3, height: 3.4 },           // BLT Stadler Tina, 44 m
  busArtic:     { sections: [11.2, 6.9], width: 2.55, height: 3.1, bus: true },             // Citaro G, 18 m
  bus:          { sections: [12.1], width: 2.55, height: 3.1, bus: true },                  // Citaro, 12 m
};
for (const [name, t] of Object.entries(TYPES)) { t.name = name; t.length = t.sections.reduce((a, b) => a + b, 0); }
const LIVERY = { BVB: 0x2e9e4f, BLT: 0xf2c318, other: 0xe4e7eb };
const GAP = .3;   // bellows between sections

const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const operator = op => /^BLT|Baselland/i.test(op || '') ? 'BLT' : /^BVB|Basler/i.test(op || '') ? 'BVB' : 'other';
export function vehicleType(j) {
  const r = hash(j.key || ''), op = operator(j.op);
  if (j.cat !== 'tram') return r < .6 ? TYPES.busArtic : TYPES.bus;
  if (op === 'BLT') return r < .6 ? TYPES.tango : TYPES.tina;
  return r < .55 ? TYPES.flexityLong : r < .75 ? TYPES.flexityShort : TYPES.combino;
}

/* ---------- local frame ---------- */
const ORIGIN = maplibregl.MercatorCoordinate.fromLngLat([7.58885, 47.55495], 0);
const S = ORIGIN.meterInMercatorCoordinateUnits();
const ORIGIN_M = new THREE.Matrix4().makeTranslation(ORIGIN.x, ORIGIN.y, ORIGIN.z).scale(new THREE.Vector3(S, S, S));
// local metres east/north/up; the world group flips y into mercator's south-pointing axis
const local = ([lat, lon]) => { const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0); return [(m.x - ORIGIN.x) / S, -(m.y - ORIGIN.y) / S]; };

/* ---------- materials ---------- */
const MAT = {
  livery: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .42, metalness: 0 }),   // no env map: metalness would only darken the paint
  accent: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .5 }),
  glass:  new THREE.MeshStandardMaterial({ color: 0x0b141c, roughness: .08, metalness: .8, emissive: 0xffb860, emissiveIntensity: 0 }),
  fixed:  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .7, metalness: .1 }),
  lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
};
const DARK = 0x1b1f24, ROOF = 0xaab3bd, METAL = 0x5d656e, WHITE = 0xfff6d8, RED = 0xff2a2a, AMBER = 0xffa31a;

/* ---------- procedural section geometry (metres, +x forward, z up, centred on the section) ---------- */
function prep(g, colour) {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  if (colour != null) { const c = new THREE.Color(colour), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.toArray(a, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
  return g;
}
function box(list, sx, sy, sz, x, y, z, colour, rotY = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z); list.push(prep(g, colour));
}
function cylinderY(list, r, len, x, y, z, colour) {
  const g = new THREE.CylinderGeometry(r, r, len, 14); g.translate(x, y, z); list.push(prep(g, colour));   // cylinder axis is y already
}
// body cross-section (y, z): slight tumblehome below the windows, rounded roof edges; extruded along x
function bodyShell(L, w, z0, z1, steps) {
  const s = new THREE.Shape(), hw = w / 2, hb = hw - .05, r = .32;
  s.moveTo(-hb, z0); s.lineTo(hb, z0); s.lineTo(hw, z0 + .55); s.lineTo(hw, z1 - r); s.quadraticCurveTo(hw, z1, hw - r, z1);
  s.lineTo(-hw + r, z1); s.quadraticCurveTo(-hw, z1, -hw, z1 - r); s.lineTo(-hw, z0 + .55); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: L, bevelEnabled: false, curveSegments: 3, steps });
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, -L / 2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));   // shape x -> y, shape y -> z, depth -> x
  return prep(g);
}
// shape the ends: plan-view taper over the last `span` metres, and at the front a raked windscreen (everything
// above `zr` leans back by `rake` metres per metre of height, fading out over the span so nothing folds)
function taper(geoms, L, front, rear) {
  for (const g of geoms) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i); let f = 1;
      if (front && x > L / 2 - front.span) {
        const u = (x - (L / 2 - front.span)) / front.span;
        f = 1 - front.k * u ** 2;
        if (z > front.zr) p.setX(i, x - (z - front.zr) * front.rake * u);
      }
      if (rear && x < -L / 2 + rear.span) f = 1 - rear.k * ((-L / 2 + rear.span - x) / rear.span) ** 2;
      p.setY(i, p.getY(i) * f);
    }
    g.computeVertexNormals();
  }
}
// side windows and right-hand doors along a section, skipping the cab zone(s)
function sideGlazing(parts, L, w, winLo, winHi, doors, keepOut) {
  const pane = 1.35, pillar = .22, y = w / 2 + .012, doorW = 1.3;
  for (const dx of doors) {
    box(parts.glass, doorW, .03, winHi - .42, dx, -y, .42 + (winHi - .42) / 2);                       // door glass, right side
    box(parts.fixed, .06, .035, winHi - .42, dx, -y, .42 + (winHi - .42) / 2, METAL);                // centre seam
  }
  const blocked = x => keepOut.some(([a, b]) => x > a && x < b);
  for (const side of [1, -1]) {
    for (let x = -L / 2 + .45 + pane / 2; x < L / 2 - .45 - pane / 2 + .01; x += pane + pillar) {
      if (blocked(x)) continue;
      if (side < 0 && doors.some(dx => Math.abs(x - dx) < (doorW + pane) / 2 + .05)) continue;
      box(parts.glass, pane, .03, winHi - winLo, x, side * y, (winLo + winHi) / 2);
    }
  }
}
function buildSection(t, i) {
  const L = t.sections[i] - GAP, w = t.width, h = t.height, n = t.sections.length;
  const front = i === 0, rear = i === n - 1;
  const parts = { livery: [], accent: [], glass: [], fixed: [], lights: [] };
  const z0 = t.bus ? .32 : .36, winLo = t.bus ? 1.1 : h - 2.1, winHi = t.bus ? h - .38 : h - .72;
  parts.livery.push(bodyShell(L, w, z0, h - .05, front || rear ? Math.round(L / .4) : 1));   // tapered ends need lengthwise vertices
  box(parts.fixed, L - .3, w - .62, .04, 0, 0, h - .04, ROOF);   // grey roof panel between the rounded edges
  // dark skirt (bogies / wheel arches) and the line-colour stripe under the windows
  for (const s of [1, -1]) {
    box(parts.fixed, L - .2, .03, .3, 0, s * (w / 2 - .03), z0 + .15, DARK);
    box(parts.accent, L - .5, .03, .13, 0, s * (w / 2 + .01), winLo - .16);
  }
  // doors: behind the cab, mid-section, near the tail
  const doors = t.bus
    ? (front ? [L / 2 - 1.2, n === 1 ? -.9 : -L / 2 + 1.8] : [L / 2 - 2.4])
    : L < 6 ? [] : front ? [L / 2 - 3.3] : rear ? [-L / 2 + 2.4] : [0];
  const cab = t.bus ? 1.2 : 2.4;
  sideGlazing(parts, L, w, winLo, winHi, doors, front ? [[L / 2 - cab, L]] : []);
  if (front) {
    // windscreen and destination display on the front face (taper() rakes them back with the nose), headlights, bumper
    const zr = t.bus ? .85 : 1.15, sh = h - .62 - zr;
    box(parts.glass, .05, w * .88, sh, L / 2 + .015, 0, zr + .05 + sh / 2);
    box(parts.lights, .05, w * .55, .24, L / 2 + .03, 0, h - .38, AMBER);
    for (const s of [1, -1]) box(parts.lights, .05, .34, .13, L / 2 + .01, s * w * .32, t.bus ? .72 : .88, WHITE);
    box(parts.fixed, .1, w * .82, .32, L / 2 - .02, 0, z0 + .2, DARK);
    // cab side windows
    for (const s of [1, -1]) box(parts.glass, cab - .6, .03, winHi - winLo + .2, L / 2 - cab / 2 - .1, s * (w / 2 + .012), (winLo + winHi) / 2 + .05);
  } else {
    box(parts.fixed, GAP + .1, w - .25, h - .7, L / 2 + GAP / 2, 0, z0 + (h - .7) / 2 + .05, DARK);   // bellows towards the section ahead
  }
  if (rear) {
    box(parts.glass, .05, w * .62, winHi - winLo - .1, -L / 2 - .005, 0, (winLo + winHi) / 2);
    for (const s of [1, -1]) box(parts.lights, .05, .3, .15, -L / 2 - .01, s * w * .36, t.bus ? 1.0 : .95, RED);
  }
  // roof
  if (t.bus) {
    if (front) box(parts.fixed, Math.min(5, L - 2), w - .5, .32, -.4, 0, h + .1, ROOF);              // eCitaro battery pods
    if (rear && n > 1) box(parts.fixed, 2.4, w - .6, .3, -L / 2 + 1.8, 0, h + .1, ROOF);
    const axles = n === 1 ? [L / 2 - 2.7, -L / 2 + 3.3] : front ? [L / 2 - 2.7, -L / 2 + 1.7] : [-L / 2 + 2.2];
    for (const x of axles) for (const s of [1, -1]) cylinderY(parts.fixed, .5, .32, x, s * (w / 2 - .12), .5, DARK);
  } else {
    if (front || rear) box(parts.fixed, 2.2, w - .7, .38, front ? -.6 : .6, 0, h + .14, ROOF);        // HVAC
    if (i === Math.floor(n / 2)) {                                                                   // pantograph
      box(parts.fixed, 1.0, 1.1, .2, 0, 0, h + .07, METAL);
      box(parts.fixed, 1.5, .06, .06, .45, 0, h + .45, METAL, -.65);
      box(parts.fixed, 1.3, .06, .06, .35, 0, h + 1.05, METAL, .55);
      box(parts.fixed, .2, 1.7, .05, -.05, 0, h + 1.33, METAL);
    }
  }
  if (front) taper(Object.values(parts).flat(), L, t.bus ? { span: .6, k: .06, zr: .85, rake: .1 } : { span: 1.6, k: .2, zr: 1.15, rake: .32 }, null);
  if (rear) taper(Object.values(parts).flat(), L, null, t.bus ? { span: .4, k: .05 } : { span: .9, k: .1 });
  return Object.entries(parts).filter(([, g]) => g.length).map(([k, g]) => ({ geometry: mergeGeometries(g), material: MAT[k], colour: k === 'livery' || k === 'accent' ? k : null }));
}

/* ---------- the same sections as GLB files, for the photoreal CesiumJS world (world3d.js) ---------- */
// Cesium cannot recolour per instance, so paint is baked in: operator livery, plus a trim colour where the
// map shows the line colour (the 3D world puts the line on a badge instead)
const BAKED = { BVB: { body: '#2f8a3c', trim: '#f2f2ee' }, BLT: { body: '#f0bf00', trim: '#c8231b' }, other: { body: '#d9dde3', trim: '#4a5260' } };
const glbCache = new Map();
export function vehicleGlbUrl(t, i, op) {
  const o = operator(op), key = `${t.name}|${i}|${o}`;
  if (!glbCache.has(key)) glbCache.set(key, (async () => {
    const scene = new THREE.Scene();
    for (const m of KINDS.get(t)[i]) {
      let material = m.material;
      if (m.userData.colour) material = new THREE.MeshStandardMaterial({ color: BAKED[o][m.userData.colour === 'livery' ? 'body' : 'trim'], roughness: .38, metalness: .2 });
      else if (material === MAT.glass) material = Object.assign(MAT.glass.clone(), { emissiveIntensity: 1 });   // world3d.js scales the glow by darkness
      scene.add(new THREE.Mesh(m.geometry, material));
    }
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    return URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  })());
  return glbCache.get(key);
}

/* ---------- instanced section kinds ---------- */
const MAX = 400;   // instances per section kind
const world = new THREE.Group(); world.matrixAutoUpdate = false; world.matrix.makeScale(1, -1, 1);
function instanced({ geometry, material, colour }) {
  const m = new THREE.InstancedMesh(geometry, material, MAX);
  m.frustumCulled = false; m.count = 0; m.userData.colour = colour;
  if (colour) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  world.add(m); return m;
}
const KINDS = new Map();   // type -> [section -> [InstancedMesh]]
function setKind(t, i, pieces) {
  if (!KINDS.has(t)) KINDS.set(t, []);
  const old = KINDS.get(t)[i]; if (old) for (const m of old) world.remove(m);
  KINDS.get(t)[i] = pieces.map(instanced);
}
for (const t of Object.values(TYPES)) t.sections.forEach((_, i) => setKind(t, i, buildSection(t, i)));

// ground marks share one unit box, scaled per instance
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const flat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const MARKS = { shadow: instanced({ geometry: unitBox, material: flat(0x000000, .38) }), late: instanced({ geometry: unitBox, material: flat(0xfb7185, .5) }), dwell: instanced({ geometry: unitBox, material: flat(0xffffff, .3) }) };

/* ---------- optional glTF models: models/manifest.json ---------- */
// { "bus": { "sections": ["citaro.glb"], "credit": "“Citaro” by … (CC BY 4.0)", "rotate": [90, 0, 0], "scale": 1 } }
// Each file is one body section in metres, nose towards +x after `rotate` (degrees, applied x then y then z; glTF is
// y-up, so [90, 0, 0] stands it up). The section is centred on its bounding box and keeps its own materials.
export async function loadModels() {
  let manifest;
  try { const res = await fetch('models/manifest.json', { cache: 'no-store' }); if (!res.ok) return []; manifest = await res.json(); } catch { return []; }
  const loader = new GLTFLoader(), credits = [];
  for (const [name, spec] of Object.entries(manifest)) {
    const t = TYPES[name]; if (!t) { console.warn(`models/manifest.json: unknown vehicle type ${name}`); continue; }
    try {
      const pieces = await Promise.all(spec.sections.map(async file => {
        const gltf = await loader.loadAsync(`models/${file}`), root = gltf.scene;
        const [rx, ry, rz] = (spec.rotate || [90, 0, 0]).map(d => d * Math.PI / 180);
        root.rotation.set(rx, ry, rz, 'XYZ'); root.scale.setScalar(spec.scale || 1); root.updateMatrixWorld(true);
        const byMat = new Map();
        root.traverse(o => { if (!o.isMesh) return; const g = o.geometry.clone().applyMatrix4(o.matrixWorld); for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a); if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push(g.index ? g.toNonIndexed() : g); });
        const all = [...byMat.values()].flat(), bbox = new THREE.Box3(); for (const g of all) { g.computeBoundingBox(); bbox.union(g.boundingBox); }
        const c = bbox.getCenter(new THREE.Vector3());
        return [...byMat].map(([material, gs]) => ({ geometry: mergeGeometries(gs).translate(-c.x, -c.y, -bbox.min.z), material, colour: null }));
      }));
      pieces.forEach((p, i) => i < t.sections.length && setKind(t, i, p));
      if (spec.credit) credits.push(spec.credit);
    } catch (e) { console.warn(`models: ${name} not loaded, keeping the procedural model`, e); }
  }
  return credits;
}

/* ---------- lighting: real sun over Basel, street light and lit interiors at night ---------- */
const sky = new THREE.HemisphereLight(0xe6eeff, 0x6f6c62, 2.2), sun = new THREE.DirectionalLight(0xffffff, 2.4);
world.add(sky, sun, sun.target);
// solar altitude/azimuth (radians, azimuth clockwise from north), NOAA approximation, good to a fraction of a degree
export function sunPosition(date, lat = 47.556, lon = 7.59) {
  const rad = Math.PI / 180, d = date / 86400000 - 10957.5;                      // days since J2000.0
  const g = (357.529 + .98560028 * d) * rad, q = 280.459 + .98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + .02 * Math.sin(2 * g)) * rad, e = (23.439 - 3.6e-7 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = ((gmst * 15 + lon) * rad - ra);
  const alt = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat * rad) - Math.sin(lat * rad) * Math.cos(ha));
  return { altitude: alt, azimuth: (az + 2 * Math.PI) % (2 * Math.PI) };
}
export function setDaylight(date) {
  const { altitude, azimuth } = sunPosition(date);
  const day = THREE.MathUtils.clamp((altitude * 180 / Math.PI + 6) / 12, 0, 1);   // 0 below -6° (night), 1 above +6°
  if (day > 0) sun.position.set(Math.sin(azimuth), Math.cos(azimuth), Math.max(.15, Math.sin(altitude)));   // local frame: east, north, up
  else sun.position.set(.45, .6, .65);                                                                    // night: oblique street light so the sides stay lit
  // night keeps the liveries readable: warm street light from above, neutral fill
  sun.intensity = 1.4 + 1.2 * day; sun.color.set(day >= 1 ? 0xffffff : day > 0 ? 0xffd2a1 : 0xffe2b8);
  sky.intensity = 2.1 + .2 * day; sky.color.set(day ? 0xe6eeff : 0xe8ebff);
  MAT.glass.emissiveIntensity = .28 * (1 - day);   // passenger compartments lit after dusk
  return day;
}
setDaylight(new Date());

/* ---------- layer ---------- */

export const vehicleLayer = {
  id: 'vehicles3d', type: 'custom', renderingMode: '3d',
  onAdd(map, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene(); this.scene.add(world);
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  },
  render(gl, args) {
    if (!MARKS.shadow.count) return;
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(ORIGIN_M);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  },
};

/* vehicles: [{ type, op, colour, late, dwell, approach, ends: [[frontLatLon, rearLatLon] per section] }] */
const M = new THREE.Matrix4(), V = new THREE.Vector3(), GREY = new THREE.Color(0x6b7280);
function mark(m, cx, cy, rot, z, sx, sy) { M.makeRotationZ(rot).scale(V.set(sx, sy, .02)).setPosition(cx, cy, z); m.setMatrixAt(m.count++, M); }
export function drawVehicles(vehicles, now) {
  for (const m of world.children) if (m.isInstancedMesh) m.count = 0;
  MARKS.dwell.material.opacity = .15 + .2 * (.5 + .5 * Math.sin(now / 320));
  for (const v of vehicles) {
    const t = v.type, kinds = KINDS.get(t);
    const livery = new THREE.Color(LIVERY[operator(v.op)]), accent = new THREE.Color(v.colour);
    if (v.approach) { livery.lerp(GREY, .6); accent.lerp(GREY, .6); }   // scheduled position, no live data: washed out
    v.ends.forEach(([a, b], i) => {
      const la = local(a), lb = local(b), cx = (la[0] + lb[0]) / 2, cy = (la[1] + lb[1]) / 2, rot = Math.atan2(la[1] - lb[1], la[0] - lb[0]);
      const L = t.sections[i] - GAP;
      mark(MARKS.shadow, cx, cy, rot, .02, L + .5, t.width + .5);
      if (v.late) mark(MARKS.late, cx, cy, rot, .04, L + 1.4, t.width + 1.6);
      if (v.dwell) mark(MARKS.dwell, cx, cy, rot, .05, L + 1, t.width + 1.2);
      M.makeRotationZ(rot).setPosition(cx, cy, 0);
      for (const m of kinds[i]) {
        if (m.count >= MAX) continue;
        const k = m.count++; m.setMatrixAt(k, M);
        if (m.userData.colour) m.setColorAt(k, m.userData.colour === 'livery' ? livery : accent);
      }
    });
  }
  for (const m of world.children) if (m.isInstancedMesh) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
}

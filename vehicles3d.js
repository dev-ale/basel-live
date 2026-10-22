/* Basel Live – 3D vehicles (placeholder models)
 * A MapLibre custom layer drawn with three.js. Every vehicle is a chain of rigid body sections laid along the track,
 * so articulated trams bend through curves. Each part (body, windows, roof…) is one InstancedMesh for the whole fleet:
 * ~12 draw calls whatever the number of vehicles.
 * Positions are metres around Barfüsserplatz; the origin is folded into the camera matrix in float64 (see spike3d.js),
 * which keeps float32 error far below a pixel at street zoom.
 */
import * as THREE from 'three';
import * as maplibregl from 'maplibre-gl';

/* ---------- fleet: approximate Basel dimensions ---------- */
// GTFS does not say which vehicle runs a trip, so the type is a stable guess per trip, weighted by fleet size
const TYPES = {
  flexityLong:  { sections: [9.4, 7.8, 8.4, 7.8, 9.4], width: 2.3, height: 3.45 },          // BVB Be 6/8 Flexity, 42.8 m
  flexityShort: { sections: [10.9, 10.0, 10.9], width: 2.3, height: 3.45 },                 // BVB Be 4/6 Flexity, 31.8 m
  combino:      { sections: [7.6, 4.4, 6.8, 4.4, 6.8, 4.4, 7.6], width: 2.3, height: 3.4 },  // BVB Be 6/8 Combino, 42 m
  tango:        { sections: [9.6, 8.6, 8.6, 8.6, 9.6], width: 2.4, height: 3.5 },           // BLT Be 6/10 Tango, 45 m
  tina:         { sections: [9.0, 8.7, 8.6, 8.7, 9.0], width: 2.3, height: 3.4 },           // BLT Stadler Tina, 44 m
  busArtic:     { sections: [11.2, 6.9], width: 2.55, height: 3.1, bus: true },             // Citaro G, 18 m
  bus:          { sections: [12.1], width: 2.55, height: 3.1, bus: true },                  // Citaro, 12 m
};
const LIVERY = { BVB: 0x1f8a4c, BLT: 0xf0c419, other: 0xd9dde3 };
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

/* ---------- parts ---------- */
const MAX = 4000;   // instances per part
const unitBox = new THREE.BoxGeometry(1, 1, 1);
function part(material, coloured) {
  const m = new THREE.InstancedMesh(unitBox, material, MAX);
  m.frustumCulled = false; m.count = 0;
  if (coloured) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  return m;
}
const flat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const P = {
  shadow: part(flat(0x000000, .35)),
  late:   part(flat(0xfb7185, .5)),
  dwell:  part(flat(0xffffff, .3)),
  skirt:  part(new THREE.MeshStandardMaterial({ color: 0x1d2329, roughness: .8 })),
  body:   part(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .45, metalness: .2 }), true),
  stripe: part(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .5 }), true),
  glass:  part(new THREE.MeshStandardMaterial({ color: 0x0c1720, roughness: .12, metalness: .7 })),
  roof:   part(new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: .6 })),
  head:   part(new THREE.MeshBasicMaterial({ color: 0xfff6d8 })),
  tail:   part(new THREE.MeshBasicMaterial({ color: 0xff2a2a })),
};
const M = new THREE.Matrix4(), GREY = new THREE.Color(0x6b7280);
// one box: section centre (cx, cy) and heading rot; offset (ox, oy, oz) in the section's own frame; size (sx, sy, sz)
function put(p, cx, cy, rot, ox, oy, oz, sx, sy, sz, color) {
  const c = Math.cos(rot), s = Math.sin(rot);
  M.makeRotationZ(rot).scale(new THREE.Vector3(sx, sy, sz)).setPosition(cx + ox * c - oy * s, cy + ox * s + oy * c, oz);
  const i = p.count++; p.setMatrixAt(i, M); if (color) p.setColorAt(i, color);
}

/* ---------- layer ---------- */
const world = new THREE.Group(); world.matrixAutoUpdate = false; world.matrix.makeScale(1, -1, 1);
Object.values(P).forEach(p => world.add(p));
world.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(-60, 90, 140); world.add(sun, sun.target);

export const vehicleLayer = {
  id: 'vehicles3d', type: 'custom', renderingMode: '3d',
  onAdd(map, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene(); this.scene.add(world);
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  },
  render(gl, args) {
    if (!P.body.count) return;
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(ORIGIN_M);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  },
};

/* vehicles: [{ type, op, colour, late, dwell, approach, ends: [[frontLatLon, rearLatLon] per section] }] */
export function drawVehicles(vehicles, now) {
  for (const p of Object.values(P)) p.count = 0;
  P.dwell.material.opacity = .15 + .2 * (.5 + .5 * Math.sin(now / 320));
  for (const v of vehicles) {
    const t = v.type, w = t.width, h = t.height, last = v.ends.length - 1;
    const body = new THREE.Color(LIVERY[operator(v.op)]), line = new THREE.Color(v.colour);
    if (v.approach) { body.lerp(GREY, .6); line.lerp(GREY, .6); }   // scheduled position, no live data: washed out
    v.ends.forEach(([a, b], i) => {
      const la = local(a), lb = local(b), cx = (la[0] + lb[0]) / 2, cy = (la[1] + lb[1]) / 2, rot = Math.atan2(la[1] - lb[1], la[0] - lb[0]);
      const L = t.sections[i] - GAP;
      put(P.shadow, cx, cy, rot, 0, 0, .02, L + .5, w + .5, .02);
      if (v.late) put(P.late, cx, cy, rot, 0, 0, .04, L + 1.4, w + 1.6, .02);
      if (v.dwell) put(P.dwell, cx, cy, rot, 0, 0, .05, L + 1, w + 1.2, .02);
      put(P.skirt, cx, cy, rot, 0, 0, .55, L, w - .05, .45);
      put(P.body, cx, cy, rot, 0, 0, .78 + (h - 1.03) / 2, L, w, h - 1.03, body);
      put(P.glass, cx, cy, rot, 0, 0, h - 1.4, L - .7, w + .02, 1.05);
      put(P.stripe, cx, cy, rot, 0, 0, h - 2.05, L - .7, w + .03, .2, line);
      put(P.roof, cx, cy, rot, 0, 0, h - .1, L - .4, w - .3, .3);
      if (i === 0) {   // front: windscreen + headlights
        put(P.glass, cx, cy, rot, L / 2 + .02, 0, h - 1.4, .08, w - .2, 1.3);
        for (const y of [-.38, .38]) put(P.head, cx, cy, rot, L / 2 + .03, y * w, 1.05, .06, .3, .15);
      }
      if (i === last) for (const y of [-.38, .38]) put(P.tail, cx, cy, rot, -L / 2 - .03, y * w, 1.05, .06, .3, .15);
    });
  }
  for (const p of Object.values(P)) { p.instanceMatrix.needsUpdate = true; if (p.instanceColor) p.instanceColor.needsUpdate = true; }
}

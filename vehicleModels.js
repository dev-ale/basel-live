/* Basel Live – procedural vehicle models (glTF 2.0, built in code, no downloads)
 * One model per car body section: rounded roof profile extruded along the car, tapered cab with windscreen,
 * window panes with pillars, glass doors, livery stripe, bogie skirt, bellows, roof gear, pantograph and lights.
 * Local frame: x forward (length), y left, z up, origin at the section centre on the rail head.
 * Glass carries an emissive interior glow that world3d.js scales with darkness; lights are unlit (always bright).
 */
const VEH_MATERIALS = {
  body:  c => ({ pbrMetallicRoughness: { baseColorFactor: c, metallicFactor: .25, roughnessFactor: .32 } }),
  trim:  c => ({ pbrMetallicRoughness: { baseColorFactor: c, metallicFactor: .25, roughnessFactor: .4 } }),
  roof:  () => ({ pbrMetallicRoughness: { baseColorFactor: [.82, .84, .86, 1], metallicFactor: .5, roughnessFactor: .5 } }),
  glass: () => ({ pbrMetallicRoughness: { baseColorFactor: [.06, .08, .1, 1], metallicFactor: .2, roughnessFactor: .06 }, emissiveFactor: [1, .78, .5] }),
  dark:  () => ({ pbrMetallicRoughness: { baseColorFactor: [.09, .1, .11, 1], metallicFactor: .1, roughnessFactor: .85 } }),
  metal: () => ({ pbrMetallicRoughness: { baseColorFactor: [.55, .57, .6, 1], metallicFactor: .85, roughnessFactor: .35 } }),
  head:  () => ({ pbrMetallicRoughness: { baseColorFactor: [1, .98, .9, 1] }, extensions: { KHR_materials_unlit: {} } }),
  tail:  () => ({ pbrMetallicRoughness: { baseColorFactor: [1, .1, .05, 1] }, extensions: { KHR_materials_unlit: {} } }),
  led:   () => ({ pbrMetallicRoughness: { baseColorFactor: [1, .62, .05, 1] }, extensions: { KHR_materials_unlit: {} } }),
};
const srgbToLinear = hex => { const v = parseInt(hex.slice(1), 16); return [16, 8, 0].map(s => ((v >> s & 255) / 255) ** 2.2).concat(1); };

function buildVehicleGltf({ kind, len, w, top, floor, cabFront, cabRear, bellowsRear, roofGear, pantograph, body, trim }) {
  const mesh = {}; const add = (m, p, n) => { (mesh[m] ??= { p: [], n: [] }); mesh[m].p.push(...p); mesh[m].n.push(...n); };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const tri = (m, a, b, c, na, nb, nc) => { const n = norm(cross(sub(b, a), sub(c, a))); add(m, [...a, ...b, ...c], [...(na || n), ...(nb || n), ...(nc || n)]); };
  const quad = (m, a, b, c, d, n) => { tri(m, a, b, c, n, n, n); tri(m, a, c, d, n, n, n); };   // a→b→c→d counter-clockwise seen from outside
  const box = (m, x0, x1, y0, y1, z0, z1) => {
    const P = (x, y, z) => [x, y, z];
    quad(m, P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)); quad(m, P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1));
    quad(m, P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)); quad(m, P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1));
    quad(m, P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)); quad(m, P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x0, y0, z0));
  };

  /* cross-section: right side up, roof arc, left side down; each edge knows its material and smooth normals */
  const W = w / 2, r = kind === 'bus' ? .22 : .42, prof = [];
  prof.push({ y: -W, z: floor, n: [-1, 0] }, { y: -W, z: top - r, n: [-1, 0] });
  for (let k = 1; k <= 5; k++) { const a = Math.PI - k / 5 * Math.PI / 2; prof.push({ y: -W + r + Math.cos(a) * r, z: top - r + Math.sin(a) * r, n: [Math.cos(a), Math.sin(a)] }); }
  for (let k = 1; k <= 5; k++) { const a = Math.PI / 2 - k / 5 * Math.PI / 2; prof.push({ y: W - r + Math.cos(a) * r, z: top - r + Math.sin(a) * r, n: [Math.cos(a), Math.sin(a)] }); }
  prof.push({ y: W, z: floor, n: [1, 0] });
  const edgeMat = i => (prof[i].z > top - .01 && prof[i + 1].z > top - .01) ? 'roof' : 'body';   // grey only on the flat roof top

  /* stations along x: straight body, cab ends taper in plan (nose) */
  const L = len / 2, nose = kind === 'bus' ? .15 : .75, st = [];
  st.push(cabRear ? { x: -L, s: .9 } : { x: -L, s: 1 });
  if (cabRear) st.push({ x: -L + nose, s: 1 });
  if (cabFront) st.push({ x: L - nose, s: 1 });
  st.push(cabFront ? { x: L, s: .9 } : { x: L, s: 1 });
  for (let a = 0; a < st.length - 1; a++) for (let i = 0; i < prof.length - 1; i++) {
    const A = st[a], B = st[a + 1], p = prof[i], q = prof[i + 1], m = edgeMat(i);
    const P = (S, v) => [S.x, v.y * S.s, v.z];
    const v0 = P(A, p), v1 = P(B, p), v2 = P(B, q), v3 = P(A, q);
    const lean = (B.s - A.s) * W / (B.x - A.x);   // taper tilts normals forward/back
    const Nn = v => norm([-lean * Math.sign(v.n[0]) * Math.abs(v.n[0]), v.n[0], v.n[1]]);
    tri(m, v0, v1, v2, Nn(p), Nn(p), Nn(q)); tri(m, v0, v2, v3, Nn(p), Nn(q), Nn(q));
  }
  /* end caps (fan from the centre of the profile) */
  for (const [S, dir] of [[st[0], -1], [st[st.length - 1], 1]]) {
    const c = [S.x, 0, (floor + top) / 2];
    for (let i = 0; i < prof.length - 1; i++) {
      const a = [S.x, prof[i].y * S.s, prof[i].z], b = [S.x, prof[i + 1].y * S.s, prof[i + 1].z];
      dir > 0 ? tri('body', c, b, a) : tri('body', c, a, b);
    }
    const bottom = [[S.x, -W * S.s, floor], [S.x, W * S.s, floor]];
    dir > 0 ? tri('body', c, bottom[0], bottom[1]) : tri('body', c, bottom[1], bottom[0]);
  }

  /* cab details: windscreen, destination display, head/tail lights */
  const off = .012, cab = (x, dir) => {
    const s = .9 * W, X = x + dir * off, F = (y, z) => [X, y, z];
    const ws = [F(-s + .12, floor + .95), F(s - .12, floor + .95), F(s - .12, top - .5), F(-s + .12, top - .5)];
    dir > 0 ? quad('glass', ...ws) : quad('glass', ws[1], ws[0], ws[3], ws[2]);
    const led = [F(-.75, top - .45), F(.75, top - .45), F(.75, top - .2), F(-.75, top - .2)];
    dir > 0 ? quad('led', ...led) : quad('led', led[1], led[0], led[3], led[2]);
    for (const y of [-s + .2, s - .55]) {
      const lights = dir > 0 ? 'head' : 'tail', l = [F(y, floor + .42), F(y + .35, floor + .42), F(y + .35, floor + .66), F(y, floor + .66)];
      dir > 0 ? quad(lights, ...l) : quad(lights, l[1], l[0], l[3], l[2]);
    }
  };
  if (cabFront) cab(L, 1);
  if (cabRear) cab(-L, -1);

  /* sides: livery stripe, window panes with pillars, glass doors */
  const x0 = -L + (cabRear ? nose + .15 : .35), x1 = L - (cabFront ? nose + .15 : .35);
  const doorW = kind === 'bus' ? 1.2 : 1.3, doorX = kind === 'bus' ? x1 - doorW / 2 - .3 : 0;
  for (const side of [-1, 1]) {
    const y = side * (W + off), Q = (m, xa, xb, za, zb) => side < 0
      ? quad(m, [xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb], [0, -1, 0]) : quad(m, [xb, y, za], [xa, y, za], [xa, y, zb], [xb, y, zb], [0, 1, 0]);
    Q('trim', -L + (cabRear ? nose : 0), L - (cabFront ? nose : 0), floor + .32, floor + .58);
    Q('glass', doorX - doorW / 2, doorX + doorW / 2, floor + .12, top - .45);
    const pane = kind === 'bus' ? 1.35 : 1.15, pillar = .16, zw0 = floor + .98, zw1 = top - .55;
    for (let x = x0; x + pane <= x1 + .01; x += pane + pillar)
      if (x + pane < doorX - doorW / 2 - .1 || x > doorX + doorW / 2 + .1) Q('glass', x, x + pane, zw0, zw1);
  }

  /* underframe, bellows, roof equipment */
  box('dark', -L + .3, L - .3, -W + .12, W - .12, .08, floor + .01);
  if (bellowsRear) box('dark', -L - .4, -L, -W + .18, W - .18, floor + .05, top - .15);
  if (roofGear) box('metal', -L * .5, L * .5, -W * .55, W * .55, top - .02, top + .38);
  if (pantograph) {
    box('metal', -.7, .7, -.55, .55, top + .38, top + .5);
    box('metal', -.05, .05, -.04, .04, top + .5, top + 1.25);
    box('metal', -.04, .04, -.7, .7, top + 1.25, top + 1.32);
  }

  /* pack into glTF */
  const mats = Object.keys(mesh), chunks = [], views = [], accessors = [], prims = []; let offset = 0;
  const pushView = arr => { const b = new Uint8Array(new Float32Array(arr).buffer); views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target: 34962 }); chunks.push(b); offset += b.length; return views.length - 1; };
  mats.forEach((m, i) => {
    const { p, n } = mesh[m], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k++) { min[k % 3] = Math.min(min[k % 3], p[k]); max[k % 3] = Math.max(max[k % 3], p[k]); }
    accessors.push({ bufferView: pushView(p), componentType: 5126, count: p.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: pushView(n), componentType: 5126, count: n.length / 3, type: 'VEC3' });
    prims.push({ attributes: { POSITION: 2 * i, NORMAL: 2 * i + 1 }, material: i, mode: 4 });
  });
  const all = new Uint8Array(offset); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  let bin = ''; for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
  return {
    asset: { version: '2.0', generator: 'basel-live vehicleModels.js' }, extensionsUsed: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: prims }],
    materials: mats.map(m => ({ name: m, ...VEH_MATERIALS[m](m === 'body' ? srgbToLinear(body) : srgbToLinear(trim)) })),
    buffers: [{ byteLength: offset, uri: 'data:application/octet-stream;base64,' + btoa(bin) }], bufferViews: views, accessors,
  };
}

/* blob URL per (livery, kind, section role): Cesium caches by URL, so all vehicles of a type share GPU buffers */
const vehicleGltfCache = new Map();
function vehicleGltfUrl(kind, spec, livery, i) {
  const n = spec.n, role = `${i === 0 ? 'F' : ''}${i === n - 1 ? 'R' : ''}${kind === 'tram' && i === 2 ? 'P' : ''}${kind === 'tram' && i % 2 ? 'G' : ''}`;
  const key = `${kind}|${livery.body}|${livery.trim}|${role}`;
  if (!vehicleGltfCache.has(key)) vehicleGltfCache.set(key, URL.createObjectURL(new Blob([JSON.stringify(buildVehicleGltf({
    kind, len: spec.len, w: spec.w, top: spec.h, floor: spec.floor, body: livery.body, trim: livery.trim,
    cabFront: i === 0, cabRear: i === n - 1 && (kind === 'tram' || n === 1), bellowsRear: i < n - 1,
    roofGear: kind === 'tram' ? i % 2 === 1 : i === 0, pantograph: kind === 'tram' && i === 2,
  }))], { type: 'model/gltf+json' })));
  return vehicleGltfCache.get(key);
}

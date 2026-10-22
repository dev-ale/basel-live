/* Basel Live – 3D world (CesiumJS, loaded on demand by the "Enter 3D" button)
 * With CESIUM_ION_TOKEN in .env: Google Photorealistic 3D Tiles via Cesium ion (textured photogrammetry).
 * Without: swisstopo open data: swissBUILDINGS3D + swissTLM3D (3D Tiles), terrain (quantized mesh), SWISSIMAGE orthophotos.
 * Vehicles are articulated box models that bend along the real track; lighting uses the real sun over Basel.
 * Reuses app.js globals: journeys, stops, routes, trackBetween, along, colourFor, textOn, popupFor, short, TRAM_LINES.
 */
const CESIUM_CDN = 'https://cdn.jsdelivr.net/npm/cesium@1.144.0/Build/Cesium/', CESIUM_LOCAL = 'vendor/cesium/';   // local copy: see README
const SWISS3D = 'https://3d.geo.admin.ch/';
const GOOGLE_3D_ION_ASSET = 2275207;
const LIVERY = { BVB: { body: '#2f8a3c', trim: '#f2f2ee' }, BLT: { body: '#f0bf00', trim: '#c8231b' }, _: { body: '#d9dde3', trim: '#4a5260' } };
const SPEC = { tram: { n: 5, len: 8.4, gap: .35, w: 2.3, h: 3.3, floor: .35 }, bus: { n: 2, len: 8.6, gap: .5, w: 2.55, h: 3.05, floor: .3 } };
const M_LAT = 110540, mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);
const lerpAngle = (a, b, k) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;

function sunAltitude(ms, lat, lon) {   // radians; simple solar ephemeris, plenty for "is it dark"
  const d = (ms - 946728000000) / 86400000, r = Math.PI / 180;
  const g = (357.529 + .98560028 * d) * r, q = 280.459 + .98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + .02 * Math.sin(2 * g)) * r, e = (23.439 - 3.6e-7 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ha = ((18.697374558 + 24.06570982441908 * d) % 24) * 15 * r + lon * r - ra;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha));
}

let cesiumLoading = null;
function loadCesium() {   // local vendor/cesium when present (fast, offline), else the CDN
  if (window.Cesium) return Promise.resolve();
  const tryFrom = base => new Promise((ok, fail) => {
    window.CESIUM_BASE_URL = base;
    const s = document.createElement('script'); s.src = base + 'Cesium.js';
    s.onload = () => { const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'Widgets/widgets.css'; document.head.appendChild(css); ok(); };
    s.onerror = () => { s.remove(); fail(new Error('could not load CesiumJS from ' + base)); };
    document.head.appendChild(s);
  });
  return cesiumLoading ??= tryFrom(CESIUM_LOCAL).catch(() => tryFrom(CESIUM_CDN));
}

const world3d = {
  active: false, viewer: null, photoreal: false, hOffset: 49.5, hQueue: [], hBusy: 0, vehModels: new Set(), vehicles: new Map(), stopH: new Map(), stopHPending: new Set(), follow: null, cab: false, sunOffset: 0, night: null,

  async enter(center, zoom) {
    $('world').classList.add('on'); document.body.classList.add('in3d');
    if (!this.viewer) { $('worldStatus').textContent = 'Loading 3D Basel…'; await loadCesium(); await this.init(); }
    this.viewer.useDefaultRenderLoop = true; this.active = true;
    const C = Cesium, range = 40000 / 2 ** (zoom - 12);
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(center.lng, center.lat, 270 + this.hOffset), 1),
      { offset: new C.HeadingPitchRange(C.Math.toRadians(-25), C.Math.toRadians(-30), Math.min(2500, Math.max(500, range))), duration: 2.5 });
  },

  exit() {   // returns the lat/lng under the screen centre so the 2D map lands in the same spot
    this.stopFollow(); this.active = false;
    const v = this.viewer, C = Cesium; let ll = null;
    const mid = new C.Cartesian2(v.canvas.clientWidth / 2, v.canvas.clientHeight / 2), ray = v.camera.getPickRay(mid);
    const hit = this.photoreal ? v.scene.pickPosition(mid) : ray && v.scene.globe.pick(ray, v.scene);
    if (hit) { const c = C.Cartographic.fromCartesian(hit); ll = [C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude)]; }
    v.useDefaultRenderLoop = false;   // stop burning the GPU while the 2D map is shown
    $('world').classList.remove('on'); document.body.classList.remove('in3d');
    return ll;
  },

  async init() {
    const C = Cesium;
    const imagery = (url, max, credit) => new C.ImageryLayer(new C.UrlTemplateImageryProvider({ url, maximumLevel: max, credit }));
    const v = this.viewer = new C.Viewer('worldCanvas', {
      baseLayer: imagery('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 19, 'Esri World Imagery'),
      terrainProvider: await C.CesiumTerrainProvider.fromUrl(SWISS3D + 'ch.swisstopo.terrain.3d/v1/', { requestVertexNormals: true }),
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
      shadows: true, terrainShadows: C.ShadowMode.ENABLED, msaaSamples: 4, contextOptions: { webgl: { powerPreference: 'high-performance' } },
    });
    v.imageryLayers.add(imagery('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', 20, '© swisstopo SWISSIMAGE'));
    v.resolutionScale = Math.min(2, window.devicePixelRatio || 1);   // render at native retina resolution
    const s = v.scene;
    s.globe.enableLighting = true; s.globe.dynamicAtmosphereLighting = true; s.globe.depthTestAgainstTerrain = true;
    s.globe.maximumScreenSpaceError = 1.5; s.globe.showGroundAtmosphere = true;
    s.highDynamicRange = true; s.postProcessStages.fxaa.enabled = true;
    if (C.Tonemapper?.PBR_NEUTRAL !== undefined) s.postProcessStages.tonemapper = C.Tonemapper.PBR_NEUTRAL;
    s.fog.enabled = true; s.fog.density = 1.2e-4;
    Object.assign(s.shadowMap, { softShadows: true, size: 4096, maximumDistance: 3000, darkness: .35 });
    s.screenSpaceCameraController.minimumZoomDistance = 3;
    const bloom = s.postProcessStages.bloom; Object.assign(bloom.uniforms, { contrast: 128, brightness: -.62, glowOnly: false, delta: 1, sigma: 1.6, stepSize: 1 });
    v.clock.shouldAnimate = true;

    const token = await fetch('config.json').then(r => r.json()).then(c => c.cesiumIonToken).catch(() => '');
    if (token) try {   // photoreal city: Google 3D tiles carry their own ground, so the globe is hidden
      C.Ion.defaultAccessToken = token;
      this.buildings = await C.Cesium3DTileset.fromIonAssetId(GOOGLE_3D_ION_ASSET, { maximumScreenSpaceError: 6, cacheBytes: 2.5e9, maximumCacheOverflowBytes: 1e9, shadows: C.ShadowMode.RECEIVE_ONLY,
        // load the screen centre first; no skipLevelOfDetail: on Google's mesh it leaves coarse slabs standing over detailed tiles
        foveatedScreenSpaceError: true, dynamicScreenSpaceError: true, preloadFlightDestinations: true });
      s.primitives.add(this.buildings); s.globe.show = false; this.photoreal = true;
      this.calibrateHeight();   // refines the 49.5 m default in the background
    } catch (e) { console.warn('Google 3D tiles via Cesium ion failed, using swisstopo', e); this.buildings = null; s.globe.show = true; }
    if (!this.photoreal) {
      this.buildings = await C.Cesium3DTileset.fromUrl(SWISS3D + 'ch.swisstopo.swissbuildings3d.3d/v1/tileset.json', { maximumScreenSpaceError: 2, shadows: C.ShadowMode.ENABLED });
      s.primitives.add(this.buildings);
    }
    this.sunLight = s.light;   // after dark: a faint bluish moonlight from above instead of a sun shining up through the ground
    this.moonLight = new C.DirectionalLight({ direction: C.Cartesian3.normalize(C.Cartesian3.negate(C.Cartesian3.fromDegrees(7.59, 47.556, 1), new C.Cartesian3()), new C.Cartesian3()), color: C.Color.fromCssColorString('#9fb4ff'), intensity: .55 });
    if (!this.photoreal) try { s.primitives.add(await C.Cesium3DTileset.fromUrl(SWISS3D + 'ch.swisstopo.swisstlm3d.3d/v1/tileset.json', { maximumScreenSpaceError: 4 })); } catch (e) { console.warn('swissTLM3D', e); }
    v.creditDisplay.addStaticCredit(new C.Credit('3D: © swisstopo · live: opentransportdata.swiss'));

    if (!this.photoreal) this.drawTracks();   // draped lines streak across Google's mesh; the real rails are in the photos anyway
    this.placeStops();   // terrain sampling runs in the background
    this.vehLayer = s.primitives.add(new C.PrimitiveCollection());
    this.vehShader = new C.CustomShader({   // warm lit interiors after dark: glass is the only emissive material
      uniforms: { u_night: { type: C.UniformType.FLOAT, value: 0 } },
      fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.emissive *= u_night * 1.6; }' });
    this.badges = s.primitives.add(new C.BillboardCollection({ scene: s }));
    this.badgeImg = new Map();

    new C.ScreenSpaceEventHandler(v.canvas).setInputAction(e => {
      const id = s.pick(e.position)?.id; if (id?.veh) this.startFollow(id.veh);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    s.preRender.addEventListener(() => { v.clock.currentTime = C.JulianDate.fromDate(new Date(Date.now() + this.sunOffset)); this.updateLight(); });
    $('worldStatus').textContent = '';
  },

  /* swisstopo terrain heights are above sea level, Google's mesh is above the ellipsoid: measure the gap on a few open squares */
  async calibrateHeight() {
    const C = Cesium, spots = [[7.5886, 47.5566], [7.5896, 47.5476], [7.5938, 47.5532], [7.5899, 47.5541], [7.6005, 47.5639]];
    const carts = spots.map(([lon, lat]) => C.Cartographic.fromDegrees(lon, lat)), mesh = carts.map(c => c.clone());
    await C.sampleTerrain(this.viewer.terrainProvider, 16, carts);
    try { await this.viewer.scene.sampleHeightMostDetailed(mesh); } catch { }
    const d = mesh.map((m, i) => m.height - carts[i].height).filter(x => Number.isFinite(x) && Math.abs(x) < 120).sort((a, b) => a - b);
    if (d.length) this.hOffset = d[d.length >> 1];   // median; ~49.5 m is the geoid height in Basel
  },

  drawTracks() {   // tram lines as coloured ribbons draped on the terrain, one batched primitive
    const C = Cesium, inst = [];
    for (const [line, r] of Object.entries(routes)) if (TRAM_LINES.test(line)) for (const seg of r.segments)
      inst.push(new C.GeometryInstance({ geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(seg.flatMap(p => [p[1], p[0]])), width: 2.5 }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(colourFor(line)).withAlpha(.55)) } }));
    if (inst.length) this.viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() }));
  },

  async placeStops() {   // stop name labels, only visible up close
    const C = Cesium, list = [...stops.values()];
    const carts = list.map(s => C.Cartographic.fromDegrees(s.lon, s.lat));
    try { await C.sampleTerrain(this.viewer.terrainProvider, 16, carts); } catch { }
    list.forEach((s, i) => { if (carts[i].height) this.stopH.set(s.id, carts[i].height); });
    const labels = this.viewer.scene.primitives.add(new C.LabelCollection());
    list.forEach((s, i) => labels.add({ position: C.Cartesian3.fromRadians(carts[i].longitude, carts[i].latitude, (carts[i].height || 260) + this.hOffset + 7),
      text: short(s.name), font: '600 26px Inter, sans-serif', scale: .5, fillColor: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#0b0e14'), outlineWidth: 4,
      style: C.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 650), disableDepthTestDistance: 300 }));
  },

  updateLight() {
    const alt = sunAltitude(Date.now() + this.sunOffset, 47.556, 7.59) * 180 / Math.PI, night = alt < -3;
    if (night === this.night) return;
    this.night = night;
    const s = this.viewer.scene;
    s.postProcessStages.bloom.enabled = night;
    s.light = night ? this.moonLight : this.sunLight;
    for (let i = 0; i < this.viewer.imageryLayers.length; i++) Object.assign(this.viewer.imageryLayers.get(i), { brightness: night ? .38 : 1, saturation: night ? .6 : 1 });
    this.buildings.style = new Cesium.Cesium3DTileStyle({ color: this.photoreal ? (night ? 'color("#59607a")' : 'color("#ffffff")') : night ? 'color("#6f7584")' : 'color("#ece5d8")' });
    this.vehShader.setUniform('u_night', night ? 1 : 0);
  },

  /* ---- vehicle models ---- */
  badge(j) {
    const k = `${j.cat}|${j.line}`; if (this.badgeImg.has(k)) return this.badgeImg.get(k);
    const c = document.createElement('canvas'), w = 64 + Math.max(0, j.line.length - 2) * 16; c.width = w; c.height = 64;
    const g = c.getContext('2d'), col = colourFor(j.line);
    g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = 5; g.beginPath();
    if (j.cat === 'bus') g.roundRect(3, 3, w - 6, 58, 29); else g.roundRect(3, 3, w - 6, 58, 14);
    g.fill(); g.stroke(); g.fillStyle = textOn(col); g.font = '700 30px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(j.line, w / 2, 34);
    this.badgeImg.set(k, c); return c;
  },

  build(j) {   // one glTF model per car section (vehicleModels.js); geometry is shared between vehicles of the same type
    const C = Cesium, sp = SPEC[j.cat] || SPEC.bus, liv = LIVERY[j.op] || LIVERY._, id = { veh: j.key };
    const veh = { j, sp, models: [], theta: [], pitch: [] };
    for (let i = 0; i < sp.n; i++)
      C.Model.fromGltfAsync({ url: vehicleGltfUrl(j.cat === 'tram' ? 'tram' : 'bus', sp, liv, i), id, upAxis: C.Axis.Z, forwardAxis: C.Axis.X,
        shadows: C.ShadowMode.ENABLED, customShader: this.vehShader, show: false })
        .then(m => { if (veh.removed) m.destroy(); else { veh.models[i] = this.vehLayer.add(m); this.vehModels.add(m); } })
        .catch(e => console.warn('vehicle model', e));
    veh.badge = this.badges.add({ image: this.badge(j), scale: .5, id, pixelOffset: new C.Cartesian2(0, -6), verticalOrigin: C.VerticalOrigin.BOTTOM,
      scaleByDistance: new C.NearFarScalar(80, 1, 4000, .45), translucencyByDistance: new C.NearFarScalar(2500, 1, 6000, 0), disableDepthTestDistance: 1200 });
    return veh;
  },

  remove(veh) {
    veh.removed = true;
    for (const m of veh.models) if (m) { this.vehModels.delete(m); this.vehLayer.remove(m); }
    this.badges.remove(veh.badge);
  },

  /* where along the track is the vehicle: segment index k (stop k → k+1), its track, and metres d into it */
  pose(j, p) {
    const s = j.stops, k = p.k;
    if (p.prev) { const tr = trackBetween(j.line, s[k], s[k + 1]); return { k, tr, d: p.t * tr.len }; }
    if (k > 0) { const tr = trackBetween(j.line, s[k - 1], s[k]); return { k: k - 1, tr, d: tr.len }; }
    if (s[1]) { const tr = trackBetween(j.line, s[0], s[1]); return { k: 0, tr, d: 0 }; }
    return null;
  },
  pointAt(j, pose, dist, fallbackH) {   // [lat, lon, h] dist metres from the start of pose's segment; may reach back one stop
    let tr = pose.tr, d = dist;
    if (d < 0 && pose.k > 0) { tr = trackBetween(j.line, j.stops[pose.k - 1], j.stops[pose.k]); d += tr.len; }
    const h = this.trackHeight(tr, Math.max(0, Math.min(tr.len, d))) ?? fallbackH;
    if (tr.len < 1) return [tr.path[0][0], tr.path[0][1], h];
    if (d >= 0) return [...along(tr, Math.min(1, d / tr.len)), h];
    const a = along(tr, 0), b = along(tr, Math.min(1, 5 / tr.len)), dy = (a[0] - b[0]) * M_LAT, dx = (a[1] - b[1]) * mLon(a[0]), n = Math.hypot(dx, dy) || 1;
    return [a[0] + dy / n * -d / M_LAT, a[1] + dx / n * -d / mLon(a[0]), h];
  },

  frame(rows, now) {
    if (!this.viewer) return;
    const C = Cesium, seen = new Set(), rot = new C.Matrix3(), tilt = new C.Matrix3(), enu = new C.Matrix4();
    for (const { j, p, isLate } of rows) {
      seen.add(j.key);
      let veh = this.vehicles.get(j.key);
      if (!veh) { veh = this.build(j); this.vehicles.set(j.key, veh); }
      const pose = this.pose(j, p); if (!pose) continue;
      if (this.follow === j.key) this.urgent = pose.tr;   // the ride-along tram gets exact heights first
      const sp = veh.sp, fb = this.heightAt(j, pose); if (fb == null) continue;
      const head = this.pointAt(j, pose, pose.d, fb);
      for (let i = 0; i < sp.n; i++) {
        const front = pose.d - i * (sp.len + sp.gap), fa = this.pointAt(j, pose, front, fb), ra = this.pointAt(j, pose, front - sp.len, fb);
        const lat = (fa[0] + ra[0]) / 2, lon = (fa[1] + ra[1]) / 2, h = (fa[2] + ra[2]) / 2, dx = (fa[1] - ra[1]) * mLon(lat), dy = (fa[0] - ra[0]) * M_LAT;
        if (Math.hypot(dx, dy) > .5) {
          veh.theta[i] = veh.theta[i] == null ? Math.atan2(dy, dx) : lerpAngle(veh.theta[i], Math.atan2(dy, dx), .35);
          veh.pitch[i] = Math.atan2(fa[2] - ra[2], Math.hypot(dx, dy));
        }
        C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(lon, lat, h), undefined, enu);
        C.Matrix3.multiply(C.Matrix3.fromRotationZ(veh.theta[i] ?? 0, rot), C.Matrix3.fromRotationY(-(veh.pitch[i] ?? 0), tilt), rot);
        const m = veh.models[i]; if (m) { m.modelMatrix = C.Matrix4.multiplyByMatrix3(enu, rot, new C.Matrix4()); m.show = true; }
        if (i === 0) { veh.front = [lat, lon, h]; veh.heading = veh.theta[0] ?? 0; }
      }
      veh.badge.position = C.Cartesian3.fromDegrees(head[1], head[0], head[2] + sp.h + 2.2);
      veh.badge.color = isLate ? C.Color.fromCssColorString('#ffb3be') : C.Color.WHITE;
    }
    for (const [k, veh] of this.vehicles) if (!seen.has(k)) { this.remove(veh); this.vehicles.delete(k); if (this.follow === k) this.stopFollow(true); }
    this.pumpHeights();
    this.updateCamera(now);
  },

  /* Heights along each track, sampled from the rendered 3D surface (Google mesh or swisstopo) every 8 m.
   * A ±32 m lower envelope drops overpasses, footbridges and tree crowns above the rails; bridges the tram
   * actually crosses are longer than that and survive. Until a track is sampled, stop terrain heights stand in. */
  trackHeight(tr, d) {
    if (tr.hs) { const x = d / 8, i = Math.min(tr.hs.length - 2, Math.floor(x)), f = Math.min(1, x - i); return tr.hs[i] + (tr.hs[i + 1] - tr.hs[i]) * f; }
    if (!tr.hq) { tr.hq = true; this.hQueue.push(tr); }
    return null;
  },
  /* Sampling pulls the most detailed tiles along a track, so it must not compete with what is on screen:
   * the ride-along track always goes first; other tracks only within 1.2 km of the camera and only once the view has loaded. */
  pumpHeights() {
    const idle = this.buildings.tilesLoaded;
    while (this.hBusy < (idle ? 2 : 1)) {
      this.hQueue = this.hQueue.filter(t => !t.hs && !t.hBusy);
      let tr = this.urgent && !this.urgent.hs && !this.urgent.hBusy ? this.urgent : null;
      if (!tr && idle) {
        const cam = this.viewer.camera.positionCartographic, clat = cam.latitude * 180 / Math.PI, clon = cam.longitude * 180 / Math.PI;
        let bd = (1200 / M_LAT) ** 2;
        for (const t of this.hQueue) { const dd = (t.path[0][0] - clat) ** 2 + ((t.path[0][1] - clon) * .68) ** 2; if (dd < bd) { bd = dd; tr = t; } }
      }
      if (!tr) return;
      tr.hBusy = true; this.hBusy++;
      this.sampleTrack(tr).catch(e => { console.warn('track heights', e); tr.hq = false; }).finally(() => { tr.hBusy = false; this.hBusy--; });
    }
  },
  async sampleTrack(tr) {
    const C = Cesium, n = Math.max(2, Math.ceil(tr.len / 8) + 1), carts = [];
    for (let i = 0; i < n; i++) { const p = along(tr, tr.len ? Math.min(1, i * 8 / tr.len) : 0); carts.push(C.Cartographic.fromDegrees(p[1], p[0])); }
    await this.viewer.scene.sampleHeightMostDetailed(carts, [...this.vehModels, this.badges]);
    let raw = carts.map(c => c.height);
    if (!raw.some(Number.isFinite)) throw new Error('no surface');
    for (let i = 0; i < n; i++) if (!Number.isFinite(raw[i])) raw[i] = raw.find(Number.isFinite);
    const R = 4, low = raw.map((_, i) => Math.min(...raw.slice(Math.max(0, i - R), i + R + 1)));
    tr.hs = Float32Array.from(low, (_, i) => { const w = low.slice(Math.max(0, i - 1), i + 2); return w.reduce((a, b) => a + b, 0) / w.length; });
  },

  /* fallback height while a track is not sampled yet: terrain at both stops (level 16, ~2 m), interpolated */
  heightAt(j, pose) {
    const a = j.stops[pose.k], b = j.stops[pose.k + 1] || a, ha = this.stopH.get(a.id), hb = this.stopH.get(b.id);
    if (ha == null || hb == null) { for (const s of [a, b]) if (!this.stopH.has(s.id)) this.stopHPending.add(s); this.sampleSoon(); return null; }
    return this.hOffset + ha + (hb - ha) * Math.min(1, Math.max(0, pose.d / (pose.tr.len || 1)));
  },
  sampleSoon() {
    if (this.sampling || !this.stopHPending.size) return;
    const list = [...this.stopHPending]; this.stopHPending.clear(); this.sampling = true;
    const carts = list.map(s => Cesium.Cartographic.fromDegrees(s.lon, s.lat));
    Cesium.sampleTerrain(this.viewer.terrainProvider, 16, carts)
      .then(() => list.forEach((s, i) => this.stopH.set(s.id, carts[i].height || 260)))
      .catch(() => list.forEach(s => this.stopH.set(s.id, 260)))
      .finally(() => { this.sampling = false; });
  },

  /* ---- ride along ---- */
  startFollow(key) {
    const j = journeys.get(key); if (!j) return;
    this.follow = key; this.camHeading = null; $('ride').classList.add('on'); this.rideInfo(true);
  },
  stopFollow(pickAnother) {
    if (!this.follow) return;
    this.follow = null; this.viewer?.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); $('ride').classList.remove('on');
    if (pickAnother && document.body.classList.contains('idle')) this.randomRide();
  },
  randomRide() {
    const trams = [...this.vehicles.values()].filter(v => v.j.cat === 'tram' && v.front && v.j.rt !== false);
    const pool = trams.length ? trams : [...this.vehicles.values()].filter(v => v.front);
    if (pool.length) this.startFollow(pool[Math.floor(Math.random() * pool.length)].j.key);
  },
  rideInfo(force) {
    const j = journeys.get(this.follow); if (!j) return;
    if (force || Date.now() - (this.infoAt || 0) > 1000) { $('rideInfo').innerHTML = popupFor(j); this.infoAt = Date.now(); }
  },
  updateCamera(now) {
    if (!this.follow) {   // screensaver: ride a random tram, switch every 90 s
      if (document.body.classList.contains('idle') && this.vehicles.size) { this.randomRide(); this.idleRideAt = now; }
      return;
    }
    if (document.body.classList.contains('idle') && now - (this.idleRideAt || now) > 90000) { this.idleRideAt = now; this.randomRide(); }
    const veh = this.vehicles.get(this.follow); if (!veh?.front) return;
    const C = Cesium, cam = this.viewer.camera, bearing = Math.PI / 2 - veh.heading;   // math angle → compass heading
    this.camHeading = this.camHeading == null ? bearing : lerpAngle(this.camHeading, bearing, .04);
    const [lat, lon, h] = veh.front, target = C.Cartesian3.fromDegrees(lon, lat, h + 2);
    if (this.cab) {
      const fwd = 1.5, eye = C.Cartesian3.fromDegrees(lon + Math.cos(veh.heading) * fwd / mLon(lat), lat + Math.sin(veh.heading) * fwd / M_LAT, h + 2.6);
      cam.lookAtTransform(C.Matrix4.IDENTITY);
      cam.setView({ destination: eye, orientation: { heading: this.camHeading, pitch: C.Math.toRadians(-4), roll: 0 } });
    } else cam.lookAt(target, new C.HeadingPitchRange(this.camHeading, C.Math.toRadians(-11), 42));
    this.rideInfo();
  },
};

/* ---- controls ---- */
$('rideChase').onclick = () => { world3d.cab = false; };
$('rideCab').onclick = () => { world3d.cab = true; };
$('rideNext').onclick = () => world3d.randomRide();
$('rideExit').onclick = () => world3d.stopFollow();
$('sun').oninput = e => { const hrs = +e.target.value; world3d.sunOffset = hrs * 3600000; $('sunLabel').textContent = hrs ? new Date(Date.now() + world3d.sunOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'; };
/* fetch CesiumJS in the background while the 2D map is up, so "Enter 3D Basel" opens fast */
window.addEventListener('load', () => setTimeout(() => (window.requestIdleCallback || setTimeout)(() => loadCesium().catch(() => { })), 3000));
window.addEventListener('keydown', e => {
  if (!world3d.active) return;
  if (e.key === 'Escape') world3d.stopFollow();
  if (e.key === 'v' || e.key === 'V') world3d.cab = !world3d.cab;
  if (e.key === 'n' || e.key === 'N') world3d.randomRide();
});

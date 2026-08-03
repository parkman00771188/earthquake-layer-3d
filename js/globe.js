/**
 * Whole-Earth view: worldwide seismicity on a globe, driven by the SAME panel
 * as the Japan box. GlobeLayer mirrors QuakeLayer's uniform names and CPU
 * helpers (setTime / bounds / bandPass / summarize), array-typed uniforms
 * (uMagSizes, uMagBand) are shared by reference with the Japan layer, and the
 * remaining scalars are copied once per frame -- so every slider, filter chip
 * and colour mode acts on both views without extra wiring.
 *
 * Data comes from data/global/: one binary per magnitude band (streamed
 * lightest-first), merged in memory into one time-sorted cloud so draw-range
 * time filtering and the rolling feed work exactly like the Japan view.
 */

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import {
  DEPTH_STOPS, MAG_STOPS, TIME_STOPS, UNIFORM_COLOR,
  glslRamp, hexToRgb,
} from './palette.js';
import { FILTER_EPS } from './quakeLayer.js';

const R = 10;                        // globe radius, world units
const KM2U = R / 6371;               // km of depth -> world units, before exag
const SIZE_BASE = 0.036;             // world radius of the smallest dot
const DAY = 86400;

const VERT = /* glsl */ `
#define EPS ${FILTER_EPS}

attribute float aMag;
attribute float aDepth;
attribute float aT;

uniform float uNow;
uniform float uFadeSpan;
uniform float uFade;
uniform float uGlowDays;
uniform float uMinMag, uMaxMag;
uniform float uMinDepth, uMaxDepth;
uniform float uSizeScale;
uniform float uMagSizes[10];
uniform float uMagScale;
uniform float uMagBand[10];
uniform float uOpacity;
uniform float uHalfHeight;
uniform float uDepthExag;
uniform int   uColorMode;
uniform float uTimeSpan;

varying vec3  vColor;
varying float vAlpha;

${glslRamp('depthColor', DEPTH_STOPS)}
${glslRamp('magColor', MAG_STOPS)}
${glslRamp('timeColor', TIME_STOPS)}

void main() {
  // position holds the surface unit vector; depth is pulled radially inward
  // here so the exaggeration slider works on the sphere too.
  vec3 wp = position * (${R.toFixed(1)} - aDepth * ${KM2U.toFixed(6)} * uDepthExag);
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;

  float pass =
      step(uMinMag   - EPS, aMag)   * step(aMag,   uMaxMag   + EPS) *
      step(uMinDepth - EPS, aDepth) * step(aDepth, uMaxDepth + EPS);
  pass *= uMagBand[int(clamp(floor(aMag), 1.0, 10.0)) - 1];

  float age = max(uNow - aT, 0.0);
  float k = uFadeSpan > 0.0 ? clamp(age / uFadeSpan, 0.0, 1.0) : 1.0;
  float alpha = uOpacity * mix(1.0, uFade, k * k);

  float glow = uGlowDays > 0.0 ? 1.0 - clamp(age / uGlowDays, 0.0, 1.0) : 0.0;
  glow = glow * glow;

  vec3 col =
      uColorMode == 0 ? depthColor(aDepth) :
      uColorMode == 1 ? magColor(aMag) :
      uColorMode == 2 ? timeColor(clamp(aT / max(uTimeSpan, 1.0), 0.0, 1.0)) :
                        vec3(${hexToRgb(UNIFORM_COLOR).map((c) => c.toFixed(4)).join(',')});

  float curve = uMagSizes[int(clamp(floor(aMag), 1.0, 10.0)) - 1];
  float sz = curve * uMagScale * uSizeScale * (1.0 + glow * 1.6);
  pass *= step(0.0005, curve);

  vColor = mix(col, vec3(1.0), glow * 0.72);
  vAlpha = alpha * pass;

  float px = sz * ${SIZE_BASE} * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.02);

  float sub = min(px / 0.8, 1.0);
  vAlpha *= sub * sub;

  gl_PointSize = pass * clamp(px, 0.8, 44.0 + sz * 2.3);
}
`;

const FRAG = /* glsl */ `
uniform float uSoft;

varying vec3  vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.002) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float edge = mix(0.14, 1.0, uSoft);
  float a = 1.0 - smoothstep(1.0 - edge, 1.0, r);
  a = pow(a, mix(1.0, 1.9, uSoft));
  gl_FragColor = vec4(vColor, vAlpha * a);
}
`;

/** Scalar uniforms copied from the Japan layer every globe frame. */
const SYNCED = [
  'uFade', 'uGlowDays', 'uMinMag', 'uMaxMag', 'uMinDepth', 'uMaxDepth',
  'uSizeScale', 'uMagScale', 'uSoft', 'uOpacity', 'uColorMode',
];

class GlobeLayer {
  /** @param merged {lon,lat,depth,mag,t} time-sorted worldwide arrays */
  constructor(merged, shared, timeSpanDays) {
    const { lon, lat, depth, mag, t } = merged;
    const n = mag.length;
    this.events = { lon, lat, depth, mag, t };
    this.count = n;

    const pos = new Float32Array(n * 3);
    const aT = new Float32Array(n);
    const tDays = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const la = (lat[i] * Math.PI) / 180;
      const lo = (lon[i] * Math.PI) / 180;
      const c = Math.cos(la);
      pos[i * 3] = c * Math.cos(lo);
      pos[i * 3 + 1] = Math.sin(la);
      pos[i * 3 + 2] = -c * Math.sin(lo);
      const d = t[i] / DAY;
      aT[i] = d;
      tDays[i] = d;
    }
    this.tDays = tDays;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.2);

    this.uniforms = {
      uNow: { value: 0 },
      uFadeSpan: { value: 60 },
      uFade: { value: shared.uFade.value },
      uGlowDays: { value: shared.uGlowDays.value },
      uMinMag: { value: shared.uMinMag.value },
      uMaxMag: { value: shared.uMaxMag.value },
      uMinDepth: { value: shared.uMinDepth.value },
      uMaxDepth: { value: shared.uMaxDepth.value },
      uSizeScale: { value: shared.uSizeScale.value },
      // Shared by reference: the panel mutates these arrays in place, so both
      // layers see per-band sizes and visibility without any copying.
      uMagSizes: { value: shared.uMagSizes.value },
      uMagScale: { value: shared.uMagScale.value },
      uMagBand: { value: shared.uMagBand.value },
      uSoft: { value: shared.uSoft.value },
      uOpacity: { value: shared.uOpacity.value },
      uHalfHeight: { value: 475 },
      uDepthExag: { value: 1.6 },
      uColorMode: { value: shared.uColorMode.value },
      uTimeSpan: { value: Math.max(1, timeSpanDays) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.range = [0, 0];
  }

  /* ── the QuakeLayer CPU contract, verbatim semantics ─────── */

  indexAtOrAfter(days) {
    const t = this.tDays;
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < days) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  setTime(nowDays, windowDays, startDays = 0) {
    const hi = this.indexAtOrAfter(nowDays + 1e-6);
    const floor = this.indexAtOrAfter(startDays);
    const lo = windowDays == null
      ? floor
      : Math.max(floor, this.indexAtOrAfter(nowDays - windowDays));
    this.uniforms.uNow.value = nowDays;
    this.uniforms.uFadeSpan.value = windowDays == null
      ? this.uniforms.uGlowDays.value
      : windowDays;
    this.range = [lo, hi];
    this.points.geometry.setDrawRange(lo, Math.max(0, hi - lo));
  }

  bounds() {
    const u = this.uniforms;
    return {
      mLo: u.uMinMag.value - FILTER_EPS, mHi: u.uMaxMag.value + FILTER_EPS,
      dLo: u.uMinDepth.value - FILTER_EPS, dHi: u.uMaxDepth.value + FILTER_EPS,
    };
  }

  magSizeAt(m) {
    const s = this.uniforms.uMagSizes.value;
    return s[Math.min(Math.max(Math.floor(m), 1), 10) - 1];
  }

  bandPass(m) {
    const band = this.uniforms.uMagBand.value;
    return band[Math.min(Math.max(Math.floor(m), 1), 10) - 1] === 1
      && this.magSizeAt(m) > 0;
  }

  summarize() {
    const { mag, depth } = this.events;
    const [lo, hi] = this.range;
    const { mLo, mHi, dLo, dHi } = this.bounds();
    let count = 0;
    let best = -1;
    let at = -1;
    for (let i = lo; i < hi; i++) {
      const m = mag[i];
      if (m < mLo || m > mHi) continue;
      const d = depth[i];
      if (d < dLo || d > dHi) continue;
      if (!this.bandPass(m)) continue;
      count++;
      if (m > best) { best = m; at = i; }
    }
    return { count, peak: at < 0 ? null : { index: at, mag: best } };
  }

  /** Is this event inside the draw range and passing every filter? */
  isDrawn(i) {
    const [lo, hi] = this.range;
    if (i < lo || i >= hi) return false;
    const { mag, depth } = this.events;
    const { mLo, mHi, dLo, dHi } = this.bounds();
    return mag[i] >= mLo && mag[i] <= mHi && depth[i] >= dLo && depth[i] <= dHi
      && this.bandPass(mag[i]);
  }

  setAdditive(on) {
    this.material.blending = on ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.needsUpdate = true;
  }

  /** Per-frame scalar mirror from the Japan layer + app state. */
  syncFrom(japan, state) {
    for (const k of SYNCED) this.uniforms[k].value = japan.uniforms[k].value;
    this.uniforms.uDepthExag.value = state.exag;
    const want = japan.material.blending;
    if (this.material.blending !== want) this.setAdditive(want === THREE.AdditiveBlending);
  }
}

/**
 * Sphere built on the SAME lat/lon convention as the quake points, with
 * equirectangular UVs -- SphereGeometry's own parameterisation does not line
 * up with our longitude mapping, and a texture rotated by half a world is a
 * miserable thing to debug.
 */
function latLonSphere(radius, segLon = 128, segLat = 64) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= segLat; j++) {
    const la = ((-90 + (180 * j) / segLat) * Math.PI) / 180;
    const c = Math.cos(la);
    for (let i = 0; i <= segLon; i++) {
      const lo = ((-180 + (360 * i) / segLon) * Math.PI) / 180;
      pos.push(radius * c * Math.cos(lo), radius * Math.sin(la), -radius * c * Math.sin(lo));
      uv.push(i / segLon, j / segLat);
    }
  }
  for (let j = 0; j < segLat; j++) {
    for (let i = 0; i < segLon; i++) {
      const a = j * (segLon + 1) + i;
      const b = a + segLon + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  return geo;
}

function stripsToSegments(strips, radius, material) {
  let segs = 0;
  for (const s of strips) segs += s.length / 2 - 1;
  const pos = new Float32Array(segs * 6);
  let k = 0;
  const put = (lon, lat) => {
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    const c = Math.cos(la);
    pos[k++] = radius * c * Math.cos(lo);
    pos[k++] = radius * Math.sin(la);
    pos[k++] = -radius * c * Math.sin(lo);
  };
  for (const s of strips) {
    for (let i = 0; i + 3 < s.length; i += 2) {
      put(s[i], s[i + 1]);
      put(s[i + 2], s[i + 3]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, material);
}

/** k-way merge of the per-band files into one time-sorted cloud. */
function mergeBands(buffers) {
  const bands = buffers.map((buf) => {
    const [magic, n] = new Uint32Array(buf, 0, 2);
    if (magic !== 0x00315147) throw new Error('bad global band file');
    const f = (k) => new Float32Array(buf, 8 + k * n * 4, n);
    return { n, lon: f(0), lat: f(1), depth: f(2), mag: f(3),
             t: new Uint32Array(buf, 8 + 4 * n * 4, n), i: 0 };
  });
  const total = bands.reduce((s, b) => s + b.n, 0);
  const out = {
    lon: new Float32Array(total), lat: new Float32Array(total),
    depth: new Float32Array(total), mag: new Float32Array(total),
    t: new Uint32Array(total),
  };
  for (let k = 0; k < total; k++) {
    let pick = -1;
    let best = Infinity;
    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      if (band.i < band.n && band.t[band.i] < best) { best = band.t[band.i]; pick = b; }
    }
    const b = bands[pick];
    const i = b.i++;
    out.lon[k] = b.lon[i]; out.lat[k] = b.lat[i]; out.depth[k] = b.depth[i];
    out.mag[k] = b.mag[i]; out.t[k] = b.t[i];
  }
  return out;
}

export class GlobeView {
  constructor(renderer, canvas) {
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
    // Open facing the app's home region: Korea/Japan (~36N 133E) dead centre.
    {
      const la = (32 * Math.PI) / 180;
      const lo = (133 * Math.PI) / 180;
      const d = R * 3.1;
      this.camera.position.set(
        d * Math.cos(la) * Math.cos(lo),
        d * Math.sin(la),
        -d * Math.cos(la) * Math.sin(lo),
      );
    }

    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08,
      rotateSpeed: 0.5, zoomSpeed: 0.7,
      enablePan: true, panSpeed: 0.7,      // right-drag moves, like the Japan view
      minDistance: R * 1.15, maxDistance: R * 8,
      autoRotate: false, autoRotateSpeed: 0.35,
      enabled: false,
    });

    this.body = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 48),
      new THREE.MeshBasicMaterial({ color: 0x080c14 }),
    );
    this.body.scale.setScalar(R * 0.82);
    this.scene.add(this.body);

    // Filled land, same recipe as the Japan map layer: flat colour whose
    // shape comes from a baked land/water alphaMap, opacity slider-driven.
    // A step brighter than the Japan quad's fill: against the pure-black space
    // backdrop the same colour reads much darker than it does over the box.
    this.landMaterial = new THREE.MeshBasicMaterial({
      color: 0x41608c,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.land = new THREE.Mesh(latLonSphere(R * 0.995), this.landMaterial);
    this.land.renderOrder = -10;
    this.land.visible = false;             // until a style + texture exist
    this.scene.add(this.land);
    this.mapStyle = 'sat';

    this.layer = null;
    this.meta = null;
    this.loading = null;
  }

  load(statusEl, shared, timeSpanDays, onReady) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const say = (t) => { if (statusEl) { statusEl.hidden = !t; statusEl.textContent = t; } };
      try {
        say('전세계 데이터 불러오는 중…');
        this.meta = await (await fetch('data/global/meta.json')).json();

        if (this.meta.land?.path) {
          new THREE.TextureLoader().load(`data/global/${this.meta.land.path}`, (tex) => {
            tex.colorSpace = THREE.NoColorSpace;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.generateMipmaps = true;
            this.maskTex = tex;
            this.landAvailable = true;
            this.applyMapStyle();
          });
        }

        fetch('data/global/basemap.json').then((r) => r.json()).then((bm) => {
          const mat = (color, opacity) => new THREE.LineBasicMaterial({
            color, transparent: true, opacity, depthWrite: false,
          });
          this.coast = stripsToSegments(bm.coast ?? [], R * 1.001, mat(0x8fa9c6, 0.3));
          this.plates = stripsToSegments(bm.plates ?? [], R * 1.003, mat(0xff8a3d, 0.55));
          this.scene.add(this.coast, this.plates);
        });

        const buffers = [];
        let got = 0;
        for (const band of this.meta.bands) {
          say(`전세계 지진 데이터 ${got}/${this.meta.bands.length} · `
            + `${this.meta.count.toLocaleString('ko-KR')}건 준비 중…`);
          buffers.push(await (await fetch(`data/global/${band.path}`)).arrayBuffer());
          got++;
        }
        say('전세계 지진 병합 중…');
        this.layer = new GlobeLayer(mergeBands(buffers), shared, timeSpanDays);
        if (this.hh) this.layer.uniforms.uHalfHeight.value = this.hh;
        this.scene.add(this.layer.points);
        say('');
        onReady?.();
      } catch (err) {
        console.error('globe data failed to load:', err);
        say('전세계 데이터를 불러오지 못했습니다. update_global.bat 로 생성하세요.');
      }
    })();
    return this.loading;
  }

  /**
   * Per-frame state mirror. The opaque core must sit beneath the deepest
   * hypocentre at the current exaggeration -- any bigger and it swallows every
   * quake below a few tens of km, erasing the depth dimension from the globe.
   */
  sync(japan, state) {
    const pull = (700 / 6371) * state.exag;
    this.body.scale.setScalar(Math.max(R * (1 - pull) * 0.985, R * 0.05));
    this.layer?.syncFrom(japan, state);
  }

  setCoastVisible(on) { if (this.coast) this.coast.visible = on; }
  setPlatesVisible(on) { if (this.plates) this.plates.visible = on; }
  setLandOpacity(v) { this.landMaterial.opacity = v; }
  setActive(on) { this.controls.enabled = on; }

  /** 'off' | 'fill' (masked flat colour) | 'sat' (Blue Marble, ocean too). */
  setMapStyle(style) {
    this.mapStyle = style;
    if (style === 'sat' && !this.satTex && !this.satLoading) {
      this.satLoading = true;
      new THREE.TextureLoader().load(
        'data/global/earth.jpg',
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          this.satTex = tex;
          this.applyMapStyle();
        },
        undefined,
        (err) => console.warn('earth.jpg failed to load:', err),
      );
    }
    this.applyMapStyle();
  }

  /** Satellite mode only: ocean on = full imagery; off = clipped to land. */
  setOceanVisible(on) {
    this.oceanOn = on;
    this.applyMapStyle();
  }

  applyMapStyle() {
    const m = this.landMaterial;
    if (this.mapStyle === 'sat' && this.satTex) {
      m.map = this.satTex;
      m.alphaMap = (this.oceanOn ?? true) ? null : (this.maskTex ?? null);
      m.color.set(0xffffff);
      this.land.visible = true;
    } else if (this.mapStyle === 'fill') {
      m.map = null;
      m.alphaMap = this.maskTex ?? null;
      m.color.set(0x41608c);
      this.land.visible = !!this.landAvailable;
    } else {
      this.land.visible = false;
    }
    m.needsUpdate = true;
  }

  update() { this.controls.update(); }

  resize(w, h, pixelRatio = 1) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.layer) this.layer.uniforms.uHalfHeight.value = (h * pixelRatio) / 2;
    this.hh = (h * pixelRatio) / 2;
  }

  /** Same principal-point shift the Japan camera uses to dodge the overlays. */
  setInsets({ width, height, left, right, bottom }) {
    this.camera.setViewOffset(width, height, (right - left) / 2, bottom / 2, width, height);
    this.camera.updateProjectionMatrix();
  }
}

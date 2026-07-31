/**
 * The event cloud: one THREE.Points with 60k+ vertices, drawn in a single call.
 *
 * Two mechanisms do all the work:
 *   - time filtering via geometry.setDrawRange(). The arrays are sorted by
 *     origin time at build time, so "everything up to T" and "a window ending
 *     at T" are both contiguous index ranges -- no per-frame CPU work.
 *   - magnitude/depth filtering, colouring and fading in the vertex shader.
 */

import * as THREE from 'three';
import { SCALE } from './projection.js';
import {
  DEPTH_STOPS, MAG_STOPS, TIME_STOPS, UNIFORM_COLOR,
  glslRamp, hexToRgb,
} from './palette.js';

const SIZE_BASE = 0.115;          // world-unit radius for the smallest event
const DAY = 86400;

/**
 * Default dot size at each integer magnitude M1..M10, in units of the smallest
 * dot. Sampled from the original curve 1 + (m - 1.73)^1.7 * 0.5 so the default
 * look is unchanged; events between integers interpolate linearly.
 */
export const MAG_SIZE_DEFAULTS = [1.0, 1.1, 1.8, 3.0, 4.8, 6.9, 9.5, 12.4, 15.6, 19.2];

/**
 * Slack applied to every range comparison, on the GPU and the CPU alike.
 *
 * Magnitudes and depths are stored as float32, so a catalogue maximum of 9.1
 * round-trips to 9.100000381 while the slider bound is the float64 9.0999999...
 * Without this epsilon the single largest event would fall outside its own
 * upper bound. Both sides must use the same value or the counts, the hit test
 * and the pixels disagree.
 */
export const FILTER_EPS = 1e-4;

const VERT = /* glsl */ `
#define EPS ${FILTER_EPS}

attribute float aMag;
attribute float aDepth;
attribute float aT;              // days since epoch

uniform float uNow;             // playhead, days since epoch
uniform float uFadeSpan;        // days over which alpha decays to uFade
uniform float uFade;            // resting alpha of older events (0..1)
uniform float uGlowDays;        // recency highlight window
uniform float uMinMag, uMaxMag;
uniform float uMinDepth, uMaxDepth;
uniform float uSizeScale;
uniform float uMagSizes[10];    // dot size at integer magnitudes M1..M10
uniform float uMagScale;        // master multiplier over the whole size curve
uniform float uMagBand[10];     // 1 shows magnitude band [m, m+1), 0 hides it
uniform float uOpacity;
uniform float uHalfHeight;
uniform int   uColorMode;       // 0 depth · 1 magnitude · 2 time · 3 uniform
uniform float uTimeSpan;        // catalogue length in days

varying vec3  vColor;
varying float vAlpha;

${glslRamp('depthColor', DEPTH_STOPS)}
${glslRamp('magColor', MAG_STOPS)}
${glslRamp('timeColor', TIME_STOPS)}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // Range filters, branch-free.
  float pass =
      step(uMinMag   - EPS, aMag)   * step(aMag,   uMaxMag   + EPS) *
      step(uMinDepth - EPS, aDepth) * step(aDepth, uMaxDepth + EPS);
  pass *= uMagBand[int(clamp(floor(aMag), 1.0, 10.0)) - 1];

  float age = max(uNow - aT, 0.0);

  // Age fade: 1.0 for fresh events, easing to uFade past uFadeSpan.
  float k = uFadeSpan > 0.0 ? clamp(age / uFadeSpan, 0.0, 1.0) : 1.0;
  float alpha = uOpacity * mix(1.0, uFade, k * k);

  // Recency glow: newest events flare bright and large.
  float glow = uGlowDays > 0.0 ? 1.0 - clamp(age / uGlowDays, 0.0, 1.0) : 0.0;
  glow = glow * glow;

  vec3 col =
      uColorMode == 0 ? depthColor(aDepth) :
      uColorMode == 1 ? magColor(aMag) :
      uColorMode == 2 ? timeColor(clamp(aT / max(uTimeSpan, 1.0), 0.0, 1.0)) :
                        vec3(${hexToRgb(UNIFORM_COLOR).map((c) => c.toFixed(4)).join(',')});

  // One size per integer band, matching the M1..M10 sliders and band toggles:
  // every M2.x event draws at exactly the M2 setting. (Blending toward the next
  // integer made a single band look like a size gradient.) A slider dragged to
  // exactly 0 hides its band; the test runs on the raw curve, before the
  // multipliers, so legitimate tiny products (0.01 x 0.01) dim, not delete.
  float curve = uMagSizes[int(clamp(floor(aMag), 1.0, 10.0)) - 1];
  float sz = curve * uMagScale * uSizeScale * (1.0 + glow * 1.6);
  pass *= step(0.0005, curve);

  vColor = mix(col, vec3(1.0), glow * 0.72);
  vAlpha = alpha * pass;

  // The upper clamp stops points ballooning when you fly in. It scales with the
  // dot's own requested size (44px at the default curve's M10 of 19.2) so slider
  // values beyond ~30 keep growing on screen instead of flattening at the cap.
  float px = sz * ${SIZE_BASE} * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.02);
  gl_PointSize = pass * clamp(px, 0.8, max(44.0, sz * 2.3));
}
`;

const FRAG = /* glsl */ `
uniform float uSoft;            // 0 = crisp disc · 1 = wide glow

varying vec3  vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.002) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;

  // At uSoft=0 the sprite is a solid disc with a one-step antialiased rim; as
  // uSoft rises the rim widens and the body falls off, giving the glow look.
  float edge = mix(0.14, 1.0, uSoft);
  float a = 1.0 - smoothstep(1.0 - edge, 1.0, r);
  a = pow(a, mix(1.0, 1.9, uSoft));

  gl_FragColor = vec4(vColor, vAlpha * a);
}
`;

export class QuakeLayer {
  constructor(data, projection) {
    this.data = data;
    this.proj = projection;

    const { events } = data;
    const n = events.count;

    const pos = new Float32Array(n * 3);
    const aT = new Float32Array(n);       // GPU attribute
    const tDays = new Float64Array(n);    // CPU-side search key
    for (let i = 0; i < n; i++) {
      pos[i * 3] = projection.x(events.lon[i]);
      pos[i * 3 + 1] = projection.y(events.depth[i]);   // exaggeration applied via group scale
      pos[i * 3 + 2] = projection.z(events.lat[i]);
      const d = events.t[i] / DAY;
      aT[i] = d;
      tDays[i] = d;
    }
    this.positions = pos;
    // Float32 resolves to only ~5e-4 days near the end of a 50-year catalogue,
    // which is coarser than any sane draw-range epsilon and would silently drop
    // the newest events. The binary search therefore uses a Float64 copy while
    // the shader keeps the compact Float32 attribute.
    this.tDays = tDays;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(events.mag, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(events.depth, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    // Points are frustum-culled as a whole; a manual sphere avoids a full
    // bounding-box computation over every draw-range change.
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, -projection.depthSpan / 2, 0),
      Math.hypot(projection.width, projection.height) * 0.75 + projection.depthSpan * 4,
    );

    this.uniforms = {
      uNow: { value: 0 },
      uFadeSpan: { value: 60 },
      uFade: { value: 0.45 },
      uGlowDays: { value: 60 },
      uMinMag: { value: 3 },
      uMaxMag: { value: 10 },
      uMinDepth: { value: 0 },
      uMaxDepth: { value: 800 },
      uSizeScale: { value: 1 },
      uMagSizes: { value: [...MAG_SIZE_DEFAULTS] },
      uMagScale: { value: 1 },
      uMagBand: { value: new Array(10).fill(1) },
      uSoft: { value: 0.3 },
      uOpacity: { value: 0.85 },
      uHalfHeight: { value: 450 },
      uColorMode: { value: 0 },
      uTimeSpan: { value: Math.max(1, data.totalDays) },
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

  /** First index with time >= days (lower bound over the sorted array). */
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

  /**
   * @param {number} nowDays playhead position
   * @param {number|null} windowDays rolling-window length, or null to accumulate
   * @param {number} startDays start of the selected period; nothing before it is drawn
   */
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

  /** Current filter bounds, widened by FILTER_EPS, for CPU-side sweeps. */
  bounds() {
    const u = this.uniforms;
    return {
      mLo: u.uMinMag.value - FILTER_EPS, mHi: u.uMaxMag.value + FILTER_EPS,
      dLo: u.uMinDepth.value - FILTER_EPS, dHi: u.uMaxDepth.value + FILTER_EPS,
    };
  }

  /** Dot size for a magnitude — the CPU twin of the shader's banded lookup. */
  magSizeAt(m) {
    const s = this.uniforms.uMagSizes.value;
    return s[Math.min(Math.max(Math.floor(m), 1), 10) - 1];
  }

  /**
   * Is this magnitude visible at all? Mirrors the two shader kill switches --
   * band toggled off, or a size curve that lands on exactly 0 -- so the feed,
   * the stats and the hit test agree with the pixels.
   */
  bandPass(m) {
    const band = this.uniforms.uMagBand.value;
    return band[Math.min(Math.max(Math.floor(m), 1), 10) - 1] === 1
      && this.magSizeAt(m) > 0;
  }

  setMagBand(m, on) {
    this.uniforms.uMagBand.value[m - 1] = on ? 1 : 0;
  }

  /**
   * Visible count and largest visible magnitude in a single pass.
   *
   * With ~900k events a full-array sweep is a few milliseconds, so the two
   * readouts share one traversal rather than each walking the array.
   */
  summarize() {
    const { mag, depth } = this.data.events;
    const [lo, hi] = this.range;
    const { mLo, mHi, dLo, dHi } = this.bounds();

    const fullyVisible = this.uniforms.uMagBand.value.every((v) => v === 1)
      && this.uniforms.uMagSizes.value.every((v) => v > 0);
    const unfiltered = fullyVisible
      && mLo <= this.data.meta.mag_min && mHi >= this.data.meta.mag_max
      && dLo <= 0 && dHi >= this.proj.depthMax;

    let count = 0;
    let best = -1;
    let at = -1;
    for (let i = lo; i < hi; i++) {
      const m = mag[i];
      if (unfiltered) {
        if (m > best) { best = m; at = i; }
        continue;
      }
      const d = depth[i];
      if (m < mLo || m > mHi || d < dLo || d > dHi) continue;
      if (!fullyVisible && !this.bandPass(m)) continue;
      count++;
      if (m > best) { best = m; at = i; }
    }
    return {
      count: unfiltered ? hi - lo : count,
      peak: at < 0 ? null : { index: at, mag: best },
    };
  }

  /** Is this event inside the draw range and passing every filter? */
  isDrawn(i) {
    const [lo, hi] = this.range;
    if (i < lo || i >= hi) return false;
    const { mag, depth } = this.data.events;
    const { mLo, mHi, dLo, dHi } = this.bounds();
    return mag[i] >= mLo && mag[i] <= mHi && depth[i] >= dLo && depth[i] <= dHi
      && this.bandPass(mag[i]);
  }

  setAdditive(on) {
    this.material.blending = on ? THREE.AdditiveBlending : THREE.NormalBlending;
    // Disabling the depth test in additive mode lets every point contribute,
    // which is what makes dense clusters read as bright cores.
    this.material.depthTest = !on;
    this.material.needsUpdate = true;
  }

  setViewportHeight(px) { this.uniforms.uHalfHeight.value = px * 0.5; }
}

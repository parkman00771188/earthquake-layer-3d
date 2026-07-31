/**
 * Whole-Earth view: worldwide seismicity on a rotating globe.
 *
 * Deliberately independent of the Japan scene -- its own camera, controls and
 * scene graph share only the WebGL renderer. Data comes from data/global/,
 * which the build pipeline splits into one binary per magnitude band; the
 * files stream in from the lightest (M5+) to the heaviest (M2), so the
 * important quakes appear within a second while the dust keeps loading.
 */

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { DEPTH_STOPS, glslRamp } from './palette.js';

const R = 10;                       // globe radius, world units
const DEPTH_EXAG = 2.0;             // hypocentre depth pull, exaggerated
const EARTH_KM = 6371;

const VERT = /* glsl */ `
attribute float aMag;
attribute float aDepth;

uniform float uHalfHeight;
uniform float uSize;

varying vec3  vColor;
varying float vAlpha;

${glslRamp('depthColor', DEPTH_STOPS)}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  vColor = depthColor(aDepth);

  // Gentle magnitude curve tuned for the global M2..M9 span.
  float sz = (0.5 + pow(max(aMag - 1.9, 0.0), 1.5) * 0.28) * uSize;
  float px = sz * 0.045 * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.02);

  float sub = min(px / 0.8, 1.0);
  vAlpha = 0.55 * sub * sub;

  gl_PointSize = clamp(px, 0.8, 22.0);
}
`;

const FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.002) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = 1.0 - smoothstep(0.55, 1.0, r);
  gl_FragColor = vec4(vColor, vAlpha * a);
}
`;

/** lat/lon/depth(km) -> position on (or under) the sphere surface. */
function toSphere(lon, lat, depth, out, i) {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const r = R * (1 - (depth / EARTH_KM) * DEPTH_EXAG);
  const c = Math.cos(la);
  out[i] = r * c * Math.cos(lo);
  out[i + 1] = r * Math.sin(la);
  out[i + 2] = -r * c * Math.sin(lo);
}

function stripsToSegments(strips, radius, material) {
  let segs = 0;
  for (const s of strips) segs += s.length / 2 - 1;
  const pos = new Float32Array(segs * 6);
  let k = 0;
  const a = new Float32Array(3);
  for (const s of strips) {
    for (let i = 0; i + 3 < s.length; i += 2) {
      toSphere(s[i], s[i + 1], 0, a, 0);
      pos[k++] = (a[0] / R) * radius; pos[k++] = (a[1] / R) * radius; pos[k++] = (a[2] / R) * radius;
      toSphere(s[i + 2], s[i + 3], 0, a, 0);
      pos[k++] = (a[0] / R) * radius; pos[k++] = (a[1] / R) * radius; pos[k++] = (a[2] / R) * radius;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, material);
}

export class GlobeView {
  constructor(renderer, canvas) {
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
    this.camera.position.set(0, R * 0.9, R * 3.1);

    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08,
      rotateSpeed: 0.5, zoomSpeed: 0.7, enablePan: false,
      minDistance: R * 1.25, maxDistance: R * 8,
      autoRotate: true, autoRotateSpeed: 0.35,
      enabled: false,
    });

    // Opaque body: occludes far-side points and coastlines.
    this.scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.985, 96, 48),
      new THREE.MeshBasicMaterial({ color: 0x080c14 }),
    ));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHalfHeight: { value: 475 },
        uSize: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.loaded = false;
    this.loading = null;
  }

  /** Fetch meta + basemap + band binaries, adding layers as they arrive. */
  load(statusEl) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const say = (t) => { if (statusEl) { statusEl.hidden = !t; statusEl.textContent = t; } };
      try {
        say('전세계 데이터 불러오는 중…');
        const meta = await (await fetch('data/global/meta.json')).json();

        fetch('data/global/basemap.json').then((r) => r.json()).then((bm) => {
          const mat = (color, opacity) => new THREE.LineBasicMaterial({
            color, transparent: true, opacity, depthWrite: false,
          });
          this.scene.add(stripsToSegments(bm.coast ?? [], R * 1.001, mat(0x8fa9c6, 0.3)));
          this.scene.add(stripsToSegments(bm.plates ?? [], R * 1.003, mat(0xff8a3d, 0.55)));
        });

        // Lightest band first: M5+ paints the planet's skeleton immediately.
        const order = [...meta.bands].sort((a, b) => a.bytes - b.bytes);
        let done = 0;
        let total = 0;
        for (const band of order) {
          say(`전세계 지진 ${done}/${order.length} 밴드 · ${total.toLocaleString('ko-KR')}건 표시 중…`);
          const buf = await (await fetch(`data/global/${band.path}`)).arrayBuffer();
          this.addBand(buf);
          done++;
          total += band.count;
        }
        say('');
        this.loaded = true;
      } catch (err) {
        console.error('globe data failed to load:', err);
        say('전세계 데이터를 불러오지 못했습니다. scripts/build_global.py 로 생성하세요.');
      }
    })();
    return this.loading;
  }

  /** One magnitude band file -> one THREE.Points. */
  addBand(buf) {
    const [magic, n] = new Uint32Array(buf, 0, 2);
    if (magic !== 0x00315147) throw new Error('bad global band file');
    const f = (k) => new Float32Array(buf, 8 + k * n * 4, n);
    const lon = f(0), lat = f(1), depth = f(2), mag = f(3);

    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) toSphere(lon[i], lat[i], depth[i], pos, i * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.1);

    this.scene.add(new THREE.Points(geo, this.material));
  }

  setActive(on) {
    this.controls.enabled = on;
    this.controls.autoRotate = on;
  }

  update() {
    this.controls.update();
  }

  resize(w, h, pixelRatio = 1) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uHalfHeight.value = (h * pixelRatio) / 2;
  }
}

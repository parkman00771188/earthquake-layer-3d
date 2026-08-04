/**
 * A pulsing ring drawn over the currently selected event.
 *
 * Implemented as a one-vertex Points so it always faces the camera and holds a
 * constant pixel size at any zoom -- a mesh ring would need billboarding and
 * would shrink into the cloud. Depth testing is off so the ring stays findable
 * even when the event sits behind a dense cluster.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
uniform float uSizePx;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSizePx;
}
`;

const FRAG = /* glsl */ `
uniform vec3  uColor;         // ring colour
uniform vec3  uHot;           // core/disc colour
uniform float uPulse;         // 0..1, animates the echo outward

void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;

  const float PI = 3.14159265;

  // Three white ripples travelling outward on staggered phases, so the whole
  // target expands together instead of pulsing in place.
  float white = 0.0;
  for (int k = 0; k < 3; k++) {
    float ph = fract(uPulse + float(k) / 3.0);
    float rad = mix(0.10, 0.88, 1.0 - pow(1.0 - ph, 1.8));
    float fade = pow(sin(PI * ph), 0.85);
    white = max(white, smoothstep(0.030, 0.005, abs(r - rad)) * fade);
  }
  // A steady hairline keeps the exact spot marked between ripples.
  white = max(white, smoothstep(0.022, 0.004, abs(r - 0.115)) * 0.55);

  // The red ring rides ahead of them: faint at the centre, full mid-flight,
  // thinning away at the rim.
  float e = 1.0 - pow(1.0 - uPulse, 2.0);
  float rad = mix(0.16, 1.0, e);
  float echo = smoothstep(mix(0.040, 0.022, e), 0.0, abs(r - rad))
             * pow(sin(PI * uPulse), 0.75);

  float a = clamp(white + echo, 0.0, 1.0);
  if (a <= 0.004) discard;

  gl_FragColor = vec4(mix(uHot, uColor, clamp(white / max(a, 1e-4), 0.0, 1.0)), a);
}
`;

export class SelectionMarker {
  constructor({ color = 0xffffff, hot = 0xff2b1f, sizePx = 100 } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.uniforms = {
      uColor: { value: new THREE.Color(color) },
      uHot: { value: new THREE.Color(hot) },
      uPulse: { value: 0 },
      uSizePx: { value: sizePx },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.visible = false;
    this.index = null;
  }

  setPixelRatio(dpr) { this.uniforms.uSizePx.value = 100 * dpr; }

  /** @param {number[]} positions flat xyz array from the quake layer */
  show(index, positions) {
    this.showAt(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
    this.index = index;
  }

  /** Place the ring at an arbitrary point (the globe has no positions array). */
  showAt(x, y, z) {
    const attr = this.points.geometry.getAttribute('position');
    attr.setXYZ(0, x, y, z);
    attr.needsUpdate = true;
    this.points.visible = true;
  }

  hide() {
    this.points.visible = false;
    this.index = null;
  }

  /** Advance the pulse; returns true while it still needs redrawing. */
  tick(dt) {
    if (!this.points.visible) return false;
    this.uniforms.uPulse.value = (this.uniforms.uPulse.value + dt * 0.45) % 1;
    return true;
  }
}

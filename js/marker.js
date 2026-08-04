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

  // Ripples leave the centre one after another. Each is white while it is
  // small and turns red as it passes the threshold radius, then keeps growing
  // out to the rim and fades. Colour is accumulated per ring so overlapping
  // ripples blend instead of one winning outright.
  vec3 acc = vec3(0.0);
  float sum = 0.0;

  for (int k = 0; k < 3; k++) {
    float ph = fract(uPulse + float(k) / 3.0);
    float rad = mix(0.05, 1.0, 1.0 - pow(1.0 - ph, 1.7));

    float ring = smoothstep(0.030, 0.005, abs(r - rad));
    float born = smoothstep(0.0, 0.10, ph);          // eases out of the centre
    float gone = 1.0 - smoothstep(0.78, 1.0, ph);    // dissolves at the rim
    float alpha = ring * born * gone;

    vec3 col = mix(uColor, uHot, smoothstep(0.62, 0.80, rad));
    acc += col * alpha;
    sum += alpha;
  }

  // A faint fixed ring keeps the exact spot marked between ripples.
  float core = smoothstep(0.022, 0.004, abs(r - 0.085)) * 0.7;
  acc += uColor * core;
  sum += core;

  float a = clamp(sum, 0.0, 1.0);
  if (a <= 0.004) discard;

  gl_FragColor = vec4(acc / max(sum, 1e-4), a);
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
    this.uniforms.uPulse.value = (this.uniforms.uPulse.value + dt * 0.25) % 1;
    return true;
  }
}

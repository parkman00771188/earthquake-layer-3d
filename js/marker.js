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

  // Five white rings fading outward mark the spot, with a red ring breathing
  // out past them. No filled centre: the event itself stays visible.
  float white = 0.0;
  for (int k = 0; k < 5; k++) {
    float rad = 0.13 + float(k) * 0.115;          // 0.13 .. 0.59
    float fade = 1.0 - float(k) * 0.17;           // dimmer further out
    white = max(white, smoothstep(0.026, 0.004, abs(r - rad)) * fade);
  }

  // Ease-out travel plus a soft fade, so the pulse glides instead of ticking.
  float e = 1.0 - pow(1.0 - uPulse, 2.2);
  float echo = smoothstep(0.032, 0.0, abs(r - mix(0.60, 1.0, e)))
             * (1.0 - smoothstep(0.55, 1.0, uPulse));

  float a = clamp(white + echo, 0.0, 1.0);
  if (a <= 0.004) discard;

  gl_FragColor = vec4(mix(uHot, uColor, white / max(a, 1e-4)), a);
}
`;

export class SelectionMarker {
  constructor({ color = 0xffffff, hot = 0xff2b1f, sizePx = 104 } = {}) {
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

  setPixelRatio(dpr) { this.uniforms.uSizePx.value = 104 * dpr; }

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
    this.uniforms.uPulse.value = (this.uniforms.uPulse.value + dt * 0.55) % 1;
    return true;
  }
}

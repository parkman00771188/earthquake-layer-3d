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

  // One eased travel curve drives everything, so the rings and the red wave
  // read as a single system rather than three independent animations.
  float grow = 1.0 - pow(1.0 - uPulse, 1.6);
  float breath = sin(PI * uPulse);

  // Two steady rings hold the target so it is legible at every instant; a
  // third rides outward with the wave and fades to nothing at both ends of the
  // cycle, which hides the loop seam.
  float white = smoothstep(0.027, 0.005, abs(r - 0.15)) * 0.85;
  white = max(white, smoothstep(0.026, 0.005, abs(r - 0.27)) * 0.6);
  float rad3 = 0.40 + grow * 0.32;
  white = max(white, smoothstep(0.028, 0.005, abs(r - rad3)) * breath * 0.85);

  // The red wave runs the same curve but the whole way out, so it leads the
  // group: faint at the centre, full mid-flight, gone at the rim.
  float rad = mix(0.18, 1.0, grow);
  float echo = smoothstep(mix(0.038, 0.020, grow), 0.0, abs(r - rad))
             * pow(breath, 0.7);

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
    this.uniforms.uPulse.value = (this.uniforms.uPulse.value + dt * 0.25) % 1;
    return true;
  }
}

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
uniform vec3  uColor;
uniform float uPulse;         // 0..1, animates the ring outward

void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;

  // Steady inner ring plus an expanding echo, so it reads as a live selection.
  float ring  = smoothstep(0.06, 0.0, abs(r - 0.52));
  float echo  = smoothstep(0.10, 0.0, abs(r - mix(0.52, 1.0, uPulse)))
              * (1.0 - uPulse);
  float dot_  = smoothstep(0.16, 0.10, r) * 0.9;

  float a = clamp(ring + echo * 0.8 + dot_, 0.0, 1.0);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export class SelectionMarker {
  constructor({ color = 0xffffff, sizePx = 30 } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.uniforms = {
      uColor: { value: new THREE.Color(color) },
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

  setPixelRatio(dpr) { this.uniforms.uSizePx.value = 30 * dpr; }

  /** @param {number[]} positions flat xyz array from the quake layer */
  show(index, positions) {
    const attr = this.points.geometry.getAttribute('position');
    attr.setXYZ(0, positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
    attr.needsUpdate = true;
    this.points.visible = true;
    this.index = index;
  }

  hide() {
    this.points.visible = false;
    this.index = null;
  }

  /** Advance the pulse; returns true while it still needs redrawing. */
  tick(dt) {
    if (!this.points.visible) return false;
    this.uniforms.uPulse.value = (this.uniforms.uPulse.value + dt * 0.8) % 1;
    return true;
  }
}

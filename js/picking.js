/**
 * Cursor -> event lookup.
 *
 * A THREE.Raycaster against 60k Points would rebuild the bounding volume and
 * test every vertex with a world-space threshold; instead we sweep the visible
 * draw range once and keep the vertex whose *angular* offset from the ray is
 * smallest, which matches how big the dot looks on screen at any zoom.
 *
 * This relies on the world group carrying only a Y scale (no rotation or
 * translation), so a vertex's world position is just (x, y * exaggeration, z).
 */

import * as THREE from 'three';

const TOLERANCE_PX = 11;

export class Picker {
  constructor(canvas, camera, world, layer) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.layer = layer;
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
  }

  /** @returns {number|null} event index under the cursor */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.ray.ray;

    // Screen-space tolerance -> tangent of the accepted cone half-angle.
    const p11 = this.camera.projectionMatrix.elements[5];
    const halfH = rect.height * 0.5;
    const tan = TOLERANCE_PX / (halfH * p11);
    const tan2 = tan * tan;

    const pos = this.layer.positions;
    const { mag, depth } = this.layer.data.events;
    const [lo, hi] = this.layer.range;
    const exag = this.world.scale.y;

    // Same epsilon-widened bounds the shader uses, so anything you can see is
    // something you can click.
    const { mLo, mHi, dLo, dHi } = this.layer.bounds();
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;

    let best = -1;
    let bestScore = tan2;

    for (let i = lo; i < hi; i++) {
      const m = mag[i];
      if (m < mLo || m > mHi) continue;
      const d = depth[i];
      if (d < dLo || d > dHi) continue;

      const wx = pos[i * 3] - ox;
      const wy = pos[i * 3 + 1] * exag - oy;
      const wz = pos[i * 3 + 2] - oz;

      const along = wx * dx + wy * dy + wz * dz;
      if (along <= 0.05) continue;

      const perp2 = wx * wx + wy * wy + wz * wz - along * along;
      if (perp2 <= 0) return i;
      const score = perp2 / (along * along);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best < 0 ? null : best;
  }
}

/**
 * HTML axis labels projected onto the 3D scene each frame.
 *
 * Kept as DOM text rather than sprites so the numbers stay crisp at any zoom.
 * Placement is camera-aware: the depth ruler moves to whichever vertical edge
 * of the cage actually fits on screen, the lat/lon rulers ride the surface
 * edges nearest the viewer, and anything that would collide or fall under the
 * panel/timeline is dropped rather than drawn half-hidden.
 */

import * as THREE from 'three';

const OUT = 0.7;         // how far labels sit outside the cage (scene units)
const MIN_RULER_PX = 55; // below this the depth axis is edge-on: show only "0 km"

export class AxisLabels {
  constructor(container, proj, world) {
    this.el = container;
    this.proj = proj;
    this.world = world;
    this.pool = [];
    this._v = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    this.visible = true;

    this.depthLabels = [0, ...steps(100, proj.depthMax, 100)]
      .map((d) => ({ depth: d, text: d === 0 ? '0 km' : String(d) }));
    this.lonLabels = [];
    this.latLabels = [];
  }

  setGraticule(lonTicks, latTicks) {
    this.lonLabels = lonTicks.map((v) => ({ lon: v, text: `${v}°E` }));
    this.latLabels = latTicks.map((v) => ({ lat: v, text: `${v}°N` }));
  }

  setVisible(on) {
    this.visible = on;
    if (!on) this.pool.forEach((n) => { n.style.display = 'none'; });
  }

  node(i) {
    if (!this.pool[i]) {
      const n = document.createElement('span');
      this.el.appendChild(n);
      this.pool[i] = n;
    }
    return this.pool[i];
  }

  /** Local scene point -> viewport pixels, or null if off screen / behind. */
  project(x, y, z, camera, view) {
    this._v.set(x, y, z).applyMatrix4(this.world.matrixWorld).project(camera);
    if (this._v.z > 1 || this._v.z < -1) return null;
    const px = (this._v.x * 0.5 + 0.5) * view.width;
    const py = (-this._v.y * 0.5 + 0.5) * view.height;
    if (px < (view.left ?? 0) + 4 || px > view.width - view.right - 4) return null;
    if (py < 6 || py > view.height - view.bottom - 6) return null;
    return { px, py };
  }

  /** The four surface corners, paired with their outward label offset. */
  corners() {
    const { xMin, xMax, zMin, zMax } = this.proj;
    return [[xMin, zMin], [xMax, zMin], [xMax, zMax], [xMin, zMax]].map(([x, z]) => {
      const sx = Math.sign(x) || 1;
      const sz = Math.sign(z) || 1;
      return { x, z, lx: x + sx * OUT, lz: z + sz * OUT };
    });
  }

  distanceTo(x, z) {
    return this._v.set(x, 0, z).applyMatrix4(this.world.matrixWorld)
      .distanceToSquared(this._cam);
  }

  /**
   * Choose the vertical edge for the depth ruler: the one showing the most
   * labels, breaking ties toward the viewer because a near edge is easier to
   * read. A near corner spreads the ruler out under perspective, so on a tight
   * viewport this naturally hands the job to a farther edge that fits.
   */
  pickDepthEdge(camera, view) {
    let best = null;
    for (const c of this.corners()) {
      let fit = 0;
      for (const d of this.depthLabels) {
        if (this.project(c.lx, this.proj.y(d.depth), c.lz, camera, view)) fit++;
      }
      const dist = this.distanceTo(c.x, c.z);
      if (!best || fit > best.fit || (fit === best.fit && dist < best.dist)) {
        best = { ...c, fit, dist };
      }
    }
    return best;
  }

  nearestCorner(camera) {
    let best = null;
    for (const c of this.corners()) {
      const dist = this.distanceTo(c.x, c.z);
      if (!best || dist < best.dist) best = { ...c, dist };
    }
    return best;
  }

  /**
   * @param {{width:number,height:number,right:number,bottom:number}} view
   *   `right`/`bottom` are the pixel insets covered by the panel and timeline.
   */
  update(camera, view) {
    if (!this.visible) return;
    camera.getWorldPosition(this._cam);

    const p = this.proj;
    const near = this.nearestCorner(camera);
    const edge = this.pickDepthEdge(camera, view);

    // Thin the depth ruler to fit the room it actually has on screen. Looking
    // down from above, the axis recedes toward the camera and the whole 700 km
    // collapses into a short diagonal, where eight numbers would be noise.
    const top = this.project(edge.lx, p.y(0), edge.lz, camera, view);
    const bottom = this.project(edge.lx, p.y(p.depthMax), edge.lz, camera, view);
    const rulerPx = top && bottom
      ? Math.hypot(bottom.px - top.px, bottom.py - top.py)
      : Infinity;

    let depthTicks;
    if (rulerPx < MIN_RULER_PX) {
      depthTicks = this.depthLabels.slice(0, 1);          // surface tick only
    } else {
      const perTick = rulerPx / Math.max(1, this.depthLabels.length - 1);
      const stride = perTick < 11 ? 4 : perTick < 21 ? 2 : 1;
      depthTicks = this.depthLabels.filter((_, i) => i % stride === 0);
    }

    // Priority order matters: when an edge collapses to a point in a side-on
    // view, the depth ruler is the one worth keeping.
    const items = [];
    for (const d of depthTicks) {
      items.push({ x: edge.lx, y: p.y(d.depth), z: edge.lz, text: d.text, cls: 'depth' });
    }
    for (const l of this.latLabels) {
      items.push({ x: near.lx, y: 0, z: p.z(l.lat), text: l.text, cls: '' });
    }
    for (const l of this.lonLabels) {
      items.push({ x: p.x(l.lon), y: 0, z: near.lz, text: l.text, cls: '' });
    }

    const taken = new Set();
    let used = 0;
    for (const item of items) {
      const at = this.project(item.x, item.y, item.z, camera, view);
      if (!at) continue;

      // Declutter on a coarse grid so collapsed axes drop to a few readable
      // labels instead of an unreadable pile. The cell is sized to a "150°E"
      // at 10px monospace plus breathing room.
      const cell = `${Math.round(at.px / 48)}:${Math.round(at.py / 17)}`;
      if (taken.has(cell)) continue;
      taken.add(cell);

      const node = this.node(used++);
      node.style.display = '';
      node.className = item.cls;
      node.style.transform =
        `translate(-50%,-50%) translate(${at.px.toFixed(1)}px,${at.py.toFixed(1)}px)`;
      if (node.textContent !== item.text) node.textContent = item.text;
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
}

function steps(from, to, step) {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(v);
  return out;
}

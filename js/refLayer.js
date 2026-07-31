/**
 * Static reference geometry: coastlines and plate boundaries on the y=0 surface,
 * a lat/lon graticule, and the depth cage that gives the cloud a sense of scale.
 *
 * Every polyline collection is flattened into a single LineSegments buffer so the
 * whole basemap costs a handful of draw calls regardless of strip count.
 */

import * as THREE from 'three';
import { graticuleStep, ticks } from './projection.js';

/** Flat [lon,lat,...] strips -> one LineSegments at height y. */
function stripsToSegments(strips, proj, y, material) {
  let segs = 0;
  for (const s of strips) segs += s.length / 2 - 1;
  if (segs <= 0) return null;

  const pos = new Float32Array(segs * 6);
  let k = 0;
  for (const s of strips) {
    for (let i = 0; i + 3 < s.length; i += 2) {
      pos[k++] = proj.x(s[i]);     pos[k++] = y; pos[k++] = proj.z(s[i + 1]);
      pos[k++] = proj.x(s[i + 2]); pos[k++] = y; pos[k++] = proj.z(s[i + 3]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, material);
}

function segmentsFromPoints(points, material) {
  const pos = new Float32Array(points.length * 3);
  points.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, material);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class RefLayer {
  constructor(basemap, proj, meta, onTextureReady) {
    this.proj = proj;
    this.group = new THREE.Group();

    const mat = (color, opacity) => new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
    });

    // ── filled land (map layer) ──────────────────────────────
    this.buildLand(meta, onTextureReady);

    // ── administrative boundaries ────────────────────────────
    // Under the coastline in the stacking order and much dimmer: context, not
    // content. Prefecture/province lines are what make it read as a map.
    this.admin = stripsToSegments(basemap.admin ?? [], proj, 0.004, mat(0x7d93ad, 0.3));
    if (this.admin) this.group.add(this.admin);
    this.borders = stripsToSegments(basemap.borders ?? [], proj, 0.006, mat(0xa8b6c8, 0.42));
    if (this.borders) this.group.add(this.borders);

    // ── coastline ────────────────────────────────────────────
    this.coast = stripsToSegments(basemap.coast ?? [], proj, 0.008, mat(0x9fc4e8, 0.7));
    if (this.coast) this.group.add(this.coast);

    // ── plate boundaries ─────────────────────────────────────
    // Lifted a hair above the surface so it never z-fights the coastline.
    this.plates = stripsToSegments(basemap.plates ?? [], proj, 0.014, mat(0xff8a3d, 0.85));
    if (this.plates) this.group.add(this.plates);

    // ── graticule + depth cage ───────────────────────────────
    this.cage = new THREE.Group();
    this.cage.add(...this.buildCage(mat));
    this.group.add(this.cage);
  }

  /**
   * The land fill, as one textured quad on the surface.
   *
   * `land.png` is a grayscale land/water mask used as an alphaMap, so the fill
   * colour and its opacity are both plain material properties -- which is what
   * lets a single slider drive it. Depth interaction is switched off entirely
   * and the quad is drawn first (renderOrder -10): otherwise, seen from above,
   * a surface plane would hide every earthquake beneath it.
   */
  buildLand(meta, onReady) {
    const p = this.proj;
    this.repaint = onReady;
    const geo = new THREE.PlaneGeometry(p.width, p.height);
    geo.rotateX(-Math.PI / 2);             // lie flat: plane +y -> scene -z (north)

    this.landMaterial = new THREE.MeshBasicMaterial({
      color: 0x2f4a63,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });

    this.land = new THREE.Mesh(geo, this.landMaterial);
    this.land.position.set((p.xMin + p.xMax) / 2, 0, (p.zMin + p.zMax) / 2);
    this.land.renderOrder = -10;
    this.land.frustumCulled = false;
    this.land.visible = false;             // shown once a style + texture exist
    this.group.add(this.land);
    this.mapStyle = 'sat';

    if (!meta?.land?.path) {
      this.landAvailable = false;
      return;
    }

    new THREE.TextureLoader().load(
      `data/${meta.land.path}`,
      (tex) => {
        tex.colorSpace = THREE.NoColorSpace;   // a mask, not colour
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = this.maxAnisotropy ?? 4;
        this.maskTex = tex;
        this.landAvailable = true;
        this.applyMapStyle();
        onReady?.();
      },
      undefined,
      (err) => {
        console.warn('land.png failed to load:', err);
        this.landAvailable = false;
        onReady?.();
      },
    );
  }

  /**
   * 'off' | 'fill' (flat colour through the land/water mask) | 'sat'
   * (Blue Marble imagery, ocean included). One quad, one material -- the
   * style just swaps which texture drives it.
   */
  setMapStyle(style) {
    this.mapStyle = style;
    if (style === 'sat' && !this.satTex && !this.satLoading) {
      this.satLoading = true;
      new THREE.TextureLoader().load(
        'data/earth-japan.jpg',
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.maxAnisotropy ?? 4;
          this.satTex = tex;
          this.applyMapStyle();
          this.repaint?.();
        },
        undefined,
        (err) => console.warn('earth-japan.jpg failed to load:', err),
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
      m.color.set(0x2f4a63);
      this.land.visible = !!this.landAvailable;
    } else {
      this.land.visible = false;
    }
    m.needsUpdate = true;
  }

  buildCage(mat) {
    const p = this.proj;
    const { xMin, xMax, zMin, zMax } = p;
    const yBot = p.y(p.depthMax);
    const r = p.region;

    const strong = [];   // outline: surface + floor + verticals
    const faint = [];    // graticule + intermediate depth layers

    // Surface outline and floor outline.
    for (const y of [0, yBot]) {
      const c = [V(xMin, y, zMin), V(xMax, y, zMin), V(xMax, y, zMax), V(xMin, y, zMax)];
      for (let i = 0; i < 4; i++) strong.push(c[i], c[(i + 1) % 4]);
    }
    // Vertical corner edges.
    for (const [x, z] of [[xMin, zMin], [xMax, zMin], [xMax, zMax], [xMin, zMax]]) {
      strong.push(V(x, 0, z), V(x, yBot, z));
    }

    // Intermediate depth layers every 100 km -- the "stacked slabs" that make
    // the dip of the subducting slab readable.
    this.depthLevels = ticks(100, p.depthMax - 1, 100);
    for (const d of this.depthLevels) {
      const y = p.y(d);
      const c = [V(xMin, y, zMin), V(xMax, y, zMin), V(xMax, y, zMax), V(xMin, y, zMax)];
      for (let i = 0; i < 4; i++) faint.push(c[i], c[(i + 1) % 4]);
    }

    // Surface graticule.
    this.lonStep = graticuleStep(r.maxlongitude - r.minlongitude);
    this.latStep = graticuleStep(r.maxlatitude - r.minlatitude);
    this.lonTicks = ticks(r.minlongitude, r.maxlongitude, this.lonStep);
    this.latTicks = ticks(r.minlatitude, r.maxlatitude, this.latStep);

    for (const lon of this.lonTicks) {
      const x = p.x(lon);
      faint.push(V(x, 0, zMin), V(x, 0, zMax));
    }
    for (const lat of this.latTicks) {
      const z = p.z(lat);
      faint.push(V(xMin, 0, z), V(xMax, 0, z));
    }

    this.strongLines = segmentsFromPoints(strong, mat(0x8fb0d6, 0.3));
    this.faintLines = segmentsFromPoints(faint, mat(0x7794b8, 0.1));
    return [this.strongLines, this.faintLines];
  }

  setCoastVisible(on) { if (this.coast) this.coast.visible = on; }
  setPlatesVisible(on) { if (this.plates) this.plates.visible = on; }
  setCageVisible(on) { this.cage.visible = on; }

  setAdminVisible(on) {
    if (this.admin) this.admin.visible = on;
    if (this.borders) this.borders.visible = on;
  }

  setLandOpacity(v) {
    if (this.landMaterial) this.landMaterial.opacity = v;
  }
}

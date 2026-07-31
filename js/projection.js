/**
 * Geographic -> scene mapping.
 *
 * An equirectangular projection about the region centre is plenty for a
 * ~3000 km box and keeps the axes readable as plain lon/lat. Scene units are
 * hundreds of kilometres (SCALE = 0.01), which puts the whole region in a
 * ~29 x 29 unit footprint -- a comfortable range for camera near/far planes.
 *
 * Vertical exaggeration is NOT baked into the vertex positions: the whole world
 * group is scaled on Y instead, so the slider is free.
 */

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.320;
export const SCALE = 0.01;           // scene units per km

export function makeProjection(meta) {
  const r = meta.region;
  const refLat = meta.projection?.reference_latitude ?? (r.minlatitude + r.maxlatitude) / 2;

  const lon0 = (r.minlongitude + r.maxlongitude) / 2;
  const lat0 = (r.minlatitude + r.maxlatitude) / 2;
  const kx = KM_PER_DEG_LON_EQ * Math.cos((refLat * Math.PI) / 180);
  const kz = KM_PER_DEG_LAT;

  // Round the depth extent up to a whole 100 km so the cage has tidy layers.
  const depthMax = Math.max(100, Math.ceil(meta.depth_max / 100) * 100);

  return {
    region: r,
    lon0, lat0, kx, kz, depthMax,

    /** longitude -> scene x (east is +x) */
    x: (lon) => (lon - lon0) * kx * SCALE,
    /** latitude -> scene z (north is -z, so the default camera looks north) */
    z: (lat) => -(lat - lat0) * kz * SCALE,
    /** depth in km -> scene y at exaggeration 1 (down is -y) */
    y: (depthKm) => -depthKm * SCALE,

    /** inverse, for axis label placement */
    lonOf: (x) => x / (kx * SCALE) + lon0,
    latOf: (z) => -z / (kz * SCALE) + lat0,

    width:  (r.maxlongitude - r.minlongitude) * kx * SCALE,
    height: (r.maxlatitude - r.minlatitude) * kz * SCALE,
    depthSpan: depthMax * SCALE,

    xMin: (r.minlongitude - lon0) * kx * SCALE,
    xMax: (r.maxlongitude - lon0) * kx * SCALE,
    zMin: -(r.maxlatitude - lat0) * kz * SCALE,   // north edge
    zMax: -(r.minlatitude - lat0) * kz * SCALE,   // south edge
  };
}

/** Nice round graticule step (degrees) for the given span. */
export function graticuleStep(spanDeg) {
  for (const s of [1, 2, 5, 10, 15]) if (spanDeg / s <= 9) return s;
  return 20;
}

/** Inclusive multiples of `step` inside [lo, hi]. */
export function ticks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Loads the generated data payload.
 *
 *   meta.json    describes the binary layout and the catalogue's extents
 *   quakes.bin   nine parallel arrays, index-aligned and sorted by origin time
 *   labels.json  dictionaries for place names, magnitude types and USGS ids
 *   basemap.json reference polylines
 *
 * Place names used to be a ~40 MB array of repeated strings. They are now a
 * Uint16 column into a few-thousand-entry dictionary, so names are available
 * immediately instead of arriving after a lazy second fetch.
 */

import { count, t } from './i18n.js';

const MAGIC = 'JQ4D';
const SUPPORTED = new Set([2]);
const DAY = 86400;

const SRC_ISC = 0;
const SRC_USGS = 1;

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getBuffer(url, onProgress) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();

  // Stream so the loader bar reflects real progress -- the payload is tens of MB.
  const chunks = [];
  let read = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
    onProgress?.(read / total);
  }
  const out = new Uint8Array(read);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

const CTORS = {
  Float32: Float32Array, Uint32: Uint32Array,
  Uint16: Uint16Array, Uint8: Uint8Array,
};

function decodeBinary(buffer, meta) {
  const tag = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (tag !== MAGIC) {
    const err = new Error(`quakes.bin: 형식이 올바르지 않습니다 (magic "${tag}")`);
    err.kind = 'stale-build';
    throw err;
  }

  const head = new Uint32Array(buffer, 4, 3);
  const [version, count] = head;
  if (!SUPPORTED.has(version)) {
    const err = new Error(`quakes.bin 형식 버전 ${version} 은 지원하지 않습니다`);
    err.kind = 'stale-build';
    throw err;
  }
  if (count !== meta.count) {
    // Almost always an interrupted build: the binary was rewritten but the
    // metadata describing it was not. Tag it so the UI can say what to do.
    const err = new Error(
      `quakes.bin has ${count.toLocaleString('ko-KR')} events but meta.json describes `
      + `${meta.count.toLocaleString('ko-KR')} — 두 파일이 서로 맞지 않습니다`);
    err.kind = 'stale-build';
    throw err;
  }

  const out = { count };
  for (const [name, spec] of Object.entries(meta.binary.arrays)) {
    const Ctor = CTORS[spec.type];
    if (!Ctor) throw new Error(`unknown array type ${spec.type} for ${name}`);
    out[name] = new Ctor(buffer, spec.offset, spec.length);
  }
  return out;
}

export async function loadData(onStage) {
  onStage?.(t('메타데이터 확인 중…'), 0.03);
  const meta = await getJSON('data/meta.json');

  const mb = (meta.binary?.bytes ?? 0) / 1e6;
  const label = `${t('지진 데이터 불러오는 중…')} ${count(meta.count)} · ${mb.toFixed(0)} MB`;

  onStage?.(label, 0.06);
  const buffer = await getBuffer('data/quakes.bin',
    (p) => onStage?.(label, 0.06 + p * 0.66));
  const events = decodeBinary(buffer, meta);

  onStage?.(t('지명 · 기준 지형 불러오는 중…'), 0.76);
  const [labels, basemap] = await Promise.all([
    getJSON('data/labels.json').catch((err) => {
      console.warn('labels.json unavailable:', err);
      return { places: [], magTypes: [], usgsIds: [] };
    }),
    getJSON('data/basemap.json').catch((err) => {
      console.warn('basemap.json unavailable:', err);
      return { coast: [], plates: [] };
    }),
  ]);

  onStage?.(t('장면 구성 중…'), 0.9);

  const epochMs = Date.parse(meta.epoch);
  const places = labels.places ?? [];
  const magTypes = labels.magTypes ?? [];
  const usgsIds = labels.usgsIds ?? [];

  return {
    meta,
    events,
    basemap,
    labels,
    epochMs,

    /** Absolute Date for an event index. */
    dateAt: (i) => new Date(epochMs + events.t[i] * 1000),
    /** Days since epoch (the unit the shader and timeline both use). */
    days: (i) => events.t[i] / DAY,
    totalDays: meta.t_max_seconds / DAY,

    placeOf: (i) => places[events.place[i]] ?? '',
    magTypeOf: (i) => magTypes[events.magType[i]] ?? '',
    sourceOf: (i) => (events.src[i] === SRC_USGS ? 'usgs' : 'isc'),

    /** Agency page for an event, or null when the id cannot be resolved. */
    urlOf: (i) => {
      if (events.src[i] === SRC_USGS) {
        const id = usgsIds[events.extId[i]];
        return id ? `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` : null;
      }
      return 'http://www.isc.ac.uk/cgi-bin/web-db-run?request=COMPREHENSIVE'
        + `&out_format=ISF2&event_id=${events.extId[i]}`;
    },
  };
}

/**
 * What the most recent data update added or revised. Written by build_data.py,
 * with event ids already resolved to array indices. Absent or malformed is a
 * normal state (no update has run yet), not an error.
 */
let changesPromise = null;
export function loadChanges() {
  changesPromise ??= getJSON('data/changes.json').catch(() => ({ available: false }));
  return changesPromise;
}

export { DAY };

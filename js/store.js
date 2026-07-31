/**
 * Settings persistence. Everything the control panel exposes, plus the camera
 * and the selected period, is written to localStorage so a reload comes back
 * exactly as you left it.
 *
 * The key is versioned: bumping VERSION retires incompatible payloads instead
 * of trying to migrate them.
 */

const KEY = 'jq4d.settings';
const VERSION = 1;

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj?.v === VERSION ? obj : {};
  } catch {
    return {};                       // private mode, quota, corrupt JSON
  }
}

export function save(payload) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...payload, v: VERSION }));
    return true;
  } catch {
    return false;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/** Trailing-edge debounce, so dragging a slider writes once when it settles. */
export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

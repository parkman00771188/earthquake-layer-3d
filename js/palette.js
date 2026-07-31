/**
 * Colour ramps shared by the GLSL point shader and the HTML legend, so the
 * two can never drift apart. Each ramp is a list of [value, hexColour] stops
 * and is interpolated piecewise-linearly in the stop's own units.
 */

// Classic seismology depth scale: hot/shallow -> cool/deep.
export const DEPTH_STOPS = [
  [0,   '#ff2b4d'],
  [35,  '#ff8c1a'],
  [70,  '#ffe14d'],
  [150, '#4ade80'],
  [300, '#38bdf8'],
  [700, '#c084fc'],
];

export const MAG_STOPS = [
  [3.0, '#3b82f6'],
  [4.5, '#22d3ee'],
  [5.5, '#a3e635'],
  [6.5, '#fbbf24'],
  [7.5, '#fb7185'],
  [9.2, '#ffffff'],
];

// Time is normalised to 0..1 across the catalogue span.
export const TIME_STOPS = [
  [0.00, '#7c3aed'],
  [0.25, '#2563eb'],
  [0.50, '#06b6d4'],
  [0.75, '#84cc16'],
  [1.00, '#fde047'],
];

export const UNIFORM_COLOR = '#a5e9ff';

/* ------------------------------------------------------------------ */

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const vec3 = (hex) => `vec3(${hexToRgb(hex).map((c) => c.toFixed(4)).join(',')})`;

/**
 * Emit a GLSL function that evaluates the ramp.
 *
 * The chained clamped mix() calls work because once a segment's parameter
 * saturates at 1.0 the accumulator equals that segment's end colour exactly,
 * and later segments contribute 0.0 until their own range is reached.
 */
export function glslRamp(name, stops) {
  let src = `vec3 ${name}(float v){\n  vec3 c = ${vec3(stops[0][1])};\n`;
  for (let i = 1; i < stops.length; i++) {
    const [v0] = stops[i - 1];
    const [v1, c1] = stops[i];
    src += `  c = mix(c, ${vec3(c1)}, clamp((v - ${f(v0)}) / ${f(v1 - v0)}, 0.0, 1.0));\n`;
  }
  return src + '  return c;\n}\n';
}

/** Evaluate a ramp on the CPU, for DOM swatches that must match the shader. */
export function rampColor(stops, v) {
  if (!(v > stops[0][0])) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v0, c0] = stops[i - 1];
    const [v1, c1] = stops[i];
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      const mix = a.map((x, k) => Math.round(255 * (x + (b[k] - x) * t)));
      return `rgb(${mix.join(',')})`;
    }
  }
  return stops[stops.length - 1][1];
}

/** CSS `linear-gradient` covering the ramp, positioned linearly in value. */
export function cssGradient(stops) {
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const parts = stops.map(([v, c]) => `${c} ${((v - lo) / (hi - lo) * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

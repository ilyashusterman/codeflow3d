/**
 * The rainbow transfer function from the reference frames: red at the domain
 * floor, through yellow/green/cyan, to blue and violet at the ceiling. This is
 * the classic "jet"-family ramp scientific viewers ship, sampled as a small
 * table and interpolated — cheap enough to call per streamline vertex.
 */
/** Stops as [t, r, g, b] with channels in 0..1. */
const STOPS: [number, number, number, number][] = [
  [0.000, 0.60, 0.00, 0.05],
  [0.070, 0.86, 0.08, 0.05],
  [0.170, 0.98, 0.32, 0.05],
  [0.280, 1.00, 0.62, 0.06],
  [0.360, 1.00, 0.85, 0.16],
  [0.440, 0.82, 0.93, 0.26],
  [0.520, 0.36, 0.86, 0.38],
  [0.600, 0.14, 0.80, 0.62],
  [0.680, 0.10, 0.74, 0.88],
  [0.780, 0.16, 0.50, 0.95],
  [0.880, 0.20, 0.24, 0.92],
  [0.950, 0.38, 0.12, 0.82],
  [1.000, 0.50, 0.05, 0.66],
];

/** Sample the ramp at normalized position t (clamped to 0..1). */
export function ramp(t: number): [number, number, number] {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  let i = 0;
  while (i < STOPS.length - 2 && x > STOPS[i + 1][0]) i++;
  const [t0, r0, g0, b0] = STOPS[i];
  const [t1, r1, g1, b1] = STOPS[i + 1];
  const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
}

/** Map a scalar in `domain` through the ramp. Values are sRGB (display) space. */
export function mapScalar(v: number, domain: [number, number]): [number, number, number] {
  return ramp((v - domain[0]) / (domain[1] - domain[0]));
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Same mapping, converted to linear-sRGB.
 *
 * three's colour management treats raw `color` buffer attributes and
 * `setRGB()` values as already-linear, so handing it display-space numbers
 * renders everything washed out and desaturated. Geometry builders must use
 * this; CSS and canvas drawing must use {@link mapScalar}.
 */
export function mapScalarLinear(v: number, domain: [number, number]): [number, number, number] {
  return rampLinear((v - domain[0]) / (domain[1] - domain[0]));
}

/** {@link ramp} in linear-sRGB, for buffer attributes and `setRGB()`. */
export function rampLinear(t: number): [number, number, number] {
  const [r, g, b] = ramp(t);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

export function cssColor(t: number, alpha = 1): string {
  const [r, g, b] = ramp(t);
  const to = (c: number) => Math.round(c * 255);
  return alpha >= 1 ? `rgb(${to(r)},${to(g)},${to(b)})` : `rgba(${to(r)},${to(g)},${to(b)},${alpha})`;
}

/** CSS gradient string for the legend bar. */
export function rampGradient(steps = 40): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${cssColor(t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

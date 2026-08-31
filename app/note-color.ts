export type RgbColor = [number, number, number];
export type LabColor = [number, number, number];
export type ColorPoint = { x: number; y: number };
export type ColorQuad = [ColorPoint, ColorPoint, ColorPoint, ColorPoint];

export const STICKY_NOTE_PALETTE = [
  "#f7dc68", // yellow
  "#f2a3b4", // pink
  "#a9d9ee", // blue
  "#b9dfa5", // green
  "#cdb8ee", // purple
  "#f2b46d", // orange
  "#f6f0df", // cream / white
  "#d6d8db", // gray
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], position: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round(clamp(position, 0, 1) * (sorted.length - 1))];
}

export function hexToRgb(hex: string): RgbColor {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function rgbToLab([red, green, blue]: RgbColor): LabColor {
  const linear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const pivot = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDistance(left: LabColor, right: LabColor) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function interpolateQuad(quad: ColorQuad, u: number, v: number) {
  const topX = quad[0].x + (quad[1].x - quad[0].x) * u;
  const topY = quad[0].y + (quad[1].y - quad[0].y) * u;
  const bottomX = quad[3].x + (quad[2].x - quad[3].x) * u;
  const bottomY = quad[3].y + (quad[2].y - quad[3].y) * u;
  return { x: topX + (bottomX - topX) * v, y: topY + (bottomY - topY) * v };
}

function edgeLength(left: ColorPoint, right: ColorPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

/**
 * Estimates the paper colour from a source-image quadrilateral. Samples are
 * selected by their proximity to the detector's Lab cluster, so black ink,
 * shadows, board background and differently coloured occluding notes cannot
 * dominate the result. Sampling follows the quadrilateral instead of its AABB.
 */
export function estimateNoteLab(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  quad: ColorQuad,
  seedLab?: LabColor,
): LabColor {
  const approximateWidth = (edgeLength(quad[0], quad[1]) + edgeLength(quad[3], quad[2])) / 2;
  const approximateHeight = (edgeLength(quad[0], quad[3]) + edgeLength(quad[1], quad[2])) / 2;
  const columns = clamp(Math.round(approximateWidth / 5), 18, 72);
  const rows = clamp(Math.round(approximateHeight / 5), 18, 72);
  const candidates: Array<{ lab: LabColor; seedDistance: number }> = [];

  // Keep a small border because an occluded note may only be visible there,
  // while still avoiding the edge shadow itself.
  const inset = 0.055;
  for (let row = 0; row < rows; row += 1) {
    const v = inset + (1 - inset * 2) * ((row + 0.5) / rows);
    for (let column = 0; column < columns; column += 1) {
      const u = inset + (1 - inset * 2) * ((column + 0.5) / columns);
      const point = interpolateQuad(quad, u, v);
      const x = clamp(Math.round(point.x), 0, width - 1);
      const y = clamp(Math.round(point.y), 0, height - 1);
      const index = (y * width + x) * 4;
      if ((rgba[index + 3] ?? 255) < 160) continue;
      const lab = rgbToLab([rgba[index], rgba[index + 1], rgba[index + 2]]);
      if (lab[0] < 18 || lab[0] > 99.8) continue;
      candidates.push({ lab, seedDistance: seedLab ? labDistance(lab, seedLab) : 0 });
    }
  }

  if (!candidates.length) return seedLab ?? [85, 0, 0];

  let inliers = candidates;
  if (seedLab) {
    const distances = candidates.map((sample) => sample.seedDistance);
    // A recovered paper can be mostly hidden. The fixed ceiling rejects an
    // occluder even when it occupies more pixels than the target paper.
    const adaptiveLimit = clamp(percentile(distances, 0.28) * 1.65 + 1.5, 6.5, 18);
    inliers = candidates.filter((sample) => sample.seedDistance <= adaptiveLimit
      && sample.lab[0] >= Math.max(20, seedLab[0] - 34));
    if (inliers.length < Math.min(18, candidates.length)) {
      inliers = [...candidates]
        .sort((left, right) => left.seedDistance - right.seedDistance)
        .slice(0, Math.max(1, Math.ceil(candidates.length * 0.18)));
    }
  } else {
    // Without a detector seed, discard dark handwriting and the brightest
    // highlights using robust lightness quantiles.
    const lightness = candidates.map((sample) => sample.lab[0]);
    const low = percentile(lightness, 0.18);
    const high = percentile(lightness, 0.94);
    inliers = candidates.filter((sample) => sample.lab[0] >= low && sample.lab[0] <= high);
  }

  const median: LabColor = [
    percentile(inliers.map((sample) => sample.lab[0]), 0.5),
    percentile(inliers.map((sample) => sample.lab[1]), 0.5),
    percentile(inliers.map((sample) => sample.lab[2]), 0.5),
  ];
  if (!seedLab) return median;

  // The full-resolution median provides local colour fidelity; a small amount
  // of the global cluster seed stabilises heavily written-on or occluded notes.
  return [
    median[0] * 0.78 + seedLab[0] * 0.22,
    median[1] * 0.78 + seedLab[1] * 0.22,
    median[2] * 0.78 + seedLab[2] * 0.22,
  ];
}

/** Illumination-tolerant distance in cylindrical Lab (LCh). */
export function stickyPaletteDistance(observed: LabColor, reference: LabColor) {
  const observedChroma = Math.hypot(observed[1], observed[2]);
  const referenceChroma = Math.hypot(reference[1], reference[2]);
  const observedHue = Math.atan2(observed[2], observed[1]);
  const referenceHue = Math.atan2(reference[2], reference[1]);
  let hueDifference = Math.abs(observedHue - referenceHue);
  if (hueDifference > Math.PI) hueDifference = Math.PI * 2 - hueDifference;
  const hueArc = 2 * Math.sqrt(observedChroma * referenceChroma) * Math.sin(hueDifference / 2);
  const lightnessDifference = (observed[0] - reference[0]) * 0.30;
  const chromaDifference = (observedChroma - referenceChroma) * 0.52;
  let distance = Math.hypot(lightnessDifference, chromaDifference, hueArc * 1.08);

  // Preserve the distinction between coloured paper and neutral white/gray,
  // even when a photo is strongly overexposed or desaturated.
  if (observedChroma >= 6 && referenceChroma < 4) distance += 14;
  if (observedChroma < 4 && referenceChroma >= 14) distance += 14;
  return distance;
}

export function nearestStickyPalette(lab: LabColor, palette: readonly string[] = STICKY_NOTE_PALETTE) {
  return palette.reduce((best, color) => {
    const distance = stickyPaletteDistance(lab, rgbToLab(hexToRgb(color)));
    return distance < best.distance ? { color, distance } : best;
  }, { color: palette[0] ?? "#f7dc68", distance: Number.POSITIVE_INFINITY }).color;
}

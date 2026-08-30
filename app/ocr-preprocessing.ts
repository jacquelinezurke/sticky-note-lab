"use client";

export type OcrPoint = { x: number; y: number };
export type OcrQuad = [OcrPoint, OcrPoint, OcrPoint, OcrPoint];

export type OcrRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  corners?: OcrQuad;
};

export type MaskComponent = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cluster: number;
};

export type TextLineBand = {
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
};

export type PreparedNoteCrops = {
  rgb: HTMLCanvasElement;
  gray: HTMLCanvasElement;
  contrast: HTMLCanvasElement;
  sauvola: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  deskewAngle: number;
};

const MAX_NOTE_SIDE = 960;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function percentile(values: number[], position: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round(clamp(position, 0, 1) * (sorted.length - 1))];
}

function distance(left: OcrPoint, right: OcrPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function boxQuad(component: MaskComponent): OcrQuad {
  return [
    { x: component.minX, y: component.minY },
    { x: component.maxX, y: component.minY },
    { x: component.maxX, y: component.maxY },
    { x: component.minX, y: component.maxY },
  ];
}

function polygonArea(points: OcrQuad) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

type LineFit = { slope: number; intercept: number };

function fitLine(samples: Array<[number, number]>): LineFit | null {
  if (samples.length < 4) return null;
  let working = samples;
  let fit: LineFit | null = null;
  for (let pass = 0; pass < 2; pass += 1) {
    const count = working.length;
    const meanX = working.reduce((sum, [x]) => sum + x, 0) / count;
    const meanY = working.reduce((sum, [, y]) => sum + y, 0) / count;
    let numerator = 0;
    let denominator = 0;
    for (const [x, y] of working) {
      numerator += (x - meanX) * (y - meanY);
      denominator += (x - meanX) ** 2;
    }
    fit = { slope: denominator > 1e-6 ? numerator / denominator : 0, intercept: meanY };
    fit.intercept -= fit.slope * meanX;
    if (!pass) {
      const residuals = working.map(([x, y]) => Math.abs(y - (fit!.slope * x + fit!.intercept)));
      const limit = Math.max(1.5, percentile(residuals, 0.78) * 1.35);
      const filtered = working.filter(([x, y]) => Math.abs(y - (fit!.slope * x + fit!.intercept)) <= limit);
      if (filtered.length >= 4) working = filtered;
    }
  }
  return fit;
}

function intersectHorizontalVertical(horizontal: LineFit, vertical: LineFit): OcrPoint | null {
  // horizontal: y = a*x+b; vertical: x = c*y+d
  const denominator = 1 - vertical.slope * horizontal.slope;
  if (Math.abs(denominator) < 1e-4) return null;
  const x = (vertical.slope * horizontal.intercept + vertical.intercept) / denominator;
  const y = horizontal.slope * x + horizontal.intercept;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function estimateQuadrilateralFromMask(
  labels: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  component: MaskComponent,
): OcrQuad {
  const fallback = boxQuad(component);
  if (maskWidth < 2 || maskHeight < 2 || labels.length < maskWidth * maskHeight) return fallback;

  const top: Array<[number, number]> = [];
  const bottom: Array<[number, number]> = [];
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  const insetX = Math.max(1, Math.floor((component.maxX - component.minX + 1) * 0.035));
  const insetY = Math.max(1, Math.floor((component.maxY - component.minY + 1) * 0.035));

  for (let x = component.minX + insetX; x <= component.maxX - insetX; x += 1) {
    let first = -1;
    let last = -1;
    for (let y = component.minY; y <= component.maxY; y += 1) {
      if (labels[y * maskWidth + x] !== component.cluster) continue;
      if (first < 0) first = y;
      last = y;
    }
    if (first >= 0) top.push([x, first]);
    if (last >= 0) bottom.push([x, last]);
  }
  for (let y = component.minY + insetY; y <= component.maxY - insetY; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = component.minX; x <= component.maxX; x += 1) {
      if (labels[y * maskWidth + x] !== component.cluster) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first >= 0) left.push([y, first]);
    if (last >= 0) right.push([y, last]);
  }

  const topFit = fitLine(top);
  const bottomFit = fitLine(bottom);
  const leftFit = fitLine(left);
  const rightFit = fitLine(right);
  if (!topFit || !bottomFit || !leftFit || !rightFit) return fallback;

  const points = [
    intersectHorizontalVertical(topFit, leftFit),
    intersectHorizontalVertical(topFit, rightFit),
    intersectHorizontalVertical(bottomFit, rightFit),
    intersectHorizontalVertical(bottomFit, leftFit),
  ];
  if (points.some((point) => !point)) return fallback;
  const quad = points as OcrQuad;
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const toleranceX = boxWidth * 0.16;
  const toleranceY = boxHeight * 0.16;
  const inside = quad.every((point) => point.x >= component.minX - toleranceX && point.x <= component.maxX + toleranceX
    && point.y >= component.minY - toleranceY && point.y <= component.maxY + toleranceY);
  const areaRatio = polygonArea(quad) / Math.max(1, boxWidth * boxHeight);
  const strongEdges = distance(quad[0], quad[1]) >= boxWidth * 0.55
    && distance(quad[2], quad[3]) >= boxWidth * 0.55
    && distance(quad[0], quad[3]) >= boxHeight * 0.55
    && distance(quad[1], quad[2]) >= boxHeight * 0.55;
  return inside && strongEdges && areaRatio >= 0.42 && areaRatio <= 1.25 ? quad : fallback;
}

function regionQuad(image: HTMLImageElement, note: OcrRegion, insetRatio: number): OcrQuad {
  const base: OcrQuad = note.corners?.length === 4
    ? note.corners.map((point) => ({
        x: clamp((point.x / 100) * image.naturalWidth, 0, image.naturalWidth - 1),
        y: clamp((point.y / 100) * image.naturalHeight, 0, image.naturalHeight - 1),
      })) as OcrQuad
    : [
        { x: (note.x / 100) * image.naturalWidth, y: (note.y / 100) * image.naturalHeight },
        { x: ((note.x + note.width) / 100) * image.naturalWidth, y: (note.y / 100) * image.naturalHeight },
        { x: ((note.x + note.width) / 100) * image.naturalWidth, y: ((note.y + note.height) / 100) * image.naturalHeight },
        { x: (note.x / 100) * image.naturalWidth, y: ((note.y + note.height) / 100) * image.naturalHeight },
      ];
  const center = base.reduce((value, point) => ({ x: value.x + point.x / 4, y: value.y + point.y / 4 }), { x: 0, y: 0 });
  const factor = 1 - insetRatio * 2;
  return base.map((point) => ({
    x: clamp(center.x + (point.x - center.x) * factor, 0, image.naturalWidth - 1),
    y: clamp(center.y + (point.y - center.y) * factor, 0, image.naturalHeight - 1),
  })) as OcrQuad;
}

type ProjectiveMap = { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number };

export function unitSquareToQuad([topLeft, topRight, bottomRight, bottomLeft]: OcrQuad): ProjectiveMap {
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-6 || Math.abs(dy3) > 1e-6) {
    if (Math.abs(denominator) > 1e-8) {
      g = (dx3 * dy2 - dx2 * dy3) / denominator;
      h = (dx1 * dy3 - dx3 * dy1) / denominator;
    }
  }
  return {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
}

export function projectPoint(map: ProjectiveMap, u: number, v: number): OcrPoint {
  const denominator = map.g * u + map.h * v + 1;
  return {
    x: (map.a * u + map.b * v + map.c) / denominator,
    y: (map.d * u + map.e * v + map.f) / denominator,
  };
}

function rectifyNote(image: HTMLImageElement, note: OcrRegion) {
  // Keep a sliver of the paper edge in RGB; later variants remove it through their local masks.
  const quad = regionQuad(image, note, -0.012);
  const naturalWidth = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const naturalHeight = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  const scale = clamp(MAX_NOTE_SIDE / Math.max(naturalWidth, naturalHeight), 0.25, 6);
  const drawnWidth = Math.max(64, Math.round(naturalWidth * scale));
  const drawnHeight = Math.max(64, Math.round(naturalHeight * scale));
  const padding = Math.round(clamp(Math.min(drawnWidth, drawnHeight) * 0.045, 16, 42));

  const minX = clamp(Math.floor(Math.min(...quad.map((point) => point.x))) - 1, 0, image.naturalWidth - 1);
  const minY = clamp(Math.floor(Math.min(...quad.map((point) => point.y))) - 1, 0, image.naturalHeight - 1);
  const maxX = clamp(Math.ceil(Math.max(...quad.map((point) => point.x))) + 1, minX + 1, image.naturalWidth);
  const maxY = clamp(Math.ceil(Math.max(...quad.map((point) => point.y))) + 1, minY + 1, image.naturalHeight);
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) return sourceCanvas;
  sourceContext.drawImage(image, minX, minY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  const source = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data;

  const canvas = document.createElement("canvas");
  canvas.width = drawnWidth + padding * 2;
  canvas.height = drawnHeight + padding * 2;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const output = context.getImageData(0, 0, canvas.width, canvas.height);
  const localQuad = quad.map((point) => ({ x: point.x - minX, y: point.y - minY })) as OcrQuad;
  const map = unitSquareToQuad(localQuad);

  for (let outputY = 0; outputY < drawnHeight; outputY += 1) {
    const v = drawnHeight <= 1 ? 0 : outputY / (drawnHeight - 1);
    for (let outputX = 0; outputX < drawnWidth; outputX += 1) {
      const u = drawnWidth <= 1 ? 0 : outputX / (drawnWidth - 1);
      const point = projectPoint(map, u, v);
      const x0 = clamp(Math.floor(point.x), 0, sourceWidth - 1);
      const y0 = clamp(Math.floor(point.y), 0, sourceHeight - 1);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const y1 = Math.min(sourceHeight - 1, y0 + 1);
      const fx = clamp(point.x - x0, 0, 1);
      const fy = clamp(point.y - y0, 0, 1);
      const destination = ((outputY + padding) * canvas.width + outputX + padding) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = source[(y0 * sourceWidth + x0) * 4 + channel] * (1 - fx)
          + source[(y0 * sourceWidth + x1) * 4 + channel] * fx;
        const bottom = source[(y1 * sourceWidth + x0) * 4 + channel] * (1 - fx)
          + source[(y1 * sourceWidth + x1) * 4 + channel] * fx;
        output.data[destination + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
      output.data[destination + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
  sourceCanvas.width = 1;
  sourceCanvas.height = 1;
  return canvas;
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function renderVariants(rgb: HTMLCanvasElement): Omit<PreparedNoteCrops, "rgb" | "deskewAngle"> {
  const context = rgb.getContext("2d", { willReadFrequently: true });
  if (!context) {
    const empty = createCanvas(rgb.width, rgb.height);
    return { gray: empty, contrast: createCanvas(rgb.width, rgb.height), sauvola: createCanvas(rgb.width, rgb.height), ink: createCanvas(rgb.width, rgb.height) };
  }
  const source = context.getImageData(0, 0, rgb.width, rgb.height);
  const count = rgb.width * rgb.height;
  const grayValues = new Float32Array(count);
  const integralWidth = rgb.width + 1;
  const integral = new Float64Array((rgb.width + 1) * (rgb.height + 1));
  const squared = new Float64Array(integral.length);
  const sampledR: number[] = [];
  const sampledG: number[] = [];
  const sampledB: number[] = [];
  const sampleStep = Math.max(1, Math.floor(count / 6000));

  for (let y = 0; y < rgb.height; y += 1) {
    let rowSum = 0;
    let rowSquared = 0;
    for (let x = 0; x < rgb.width; x += 1) {
      const pixel = y * rgb.width + x;
      const offset = pixel * 4;
      const luminance = source.data[offset] * 0.299 + source.data[offset + 1] * 0.587 + source.data[offset + 2] * 0.114;
      grayValues[pixel] = luminance;
      rowSum += luminance;
      rowSquared += luminance * luminance;
      const integralIndex = (y + 1) * integralWidth + x + 1;
      integral[integralIndex] = integral[integralIndex - integralWidth] + rowSum;
      squared[integralIndex] = squared[integralIndex - integralWidth] + rowSquared;
      if (pixel % sampleStep === 0 && luminance > 70) {
        sampledR.push(source.data[offset]);
        sampledG.push(source.data[offset + 1]);
        sampledB.push(source.data[offset + 2]);
      }
    }
  }

  const background = [
    Math.max(64, percentile(sampledR, 0.72)),
    Math.max(64, percentile(sampledG, 0.72)),
    Math.max(64, percentile(sampledB, 0.72)),
  ];
  const outputs = {
    gray: createCanvas(rgb.width, rgb.height),
    contrast: createCanvas(rgb.width, rgb.height),
    sauvola: createCanvas(rgb.width, rgb.height),
    ink: createCanvas(rgb.width, rgb.height),
  };
  const images = Object.fromEntries(Object.entries(outputs).map(([key, canvas]) => {
    const outputContext = canvas.getContext("2d");
    return [key, { context: outputContext, pixels: outputContext?.createImageData(rgb.width, rgb.height) }];
  })) as Record<keyof typeof outputs, { context: CanvasRenderingContext2D | null; pixels: ImageData | undefined }>;
  const windowSize = (Math.round(clamp(Math.min(rgb.width, rgb.height) * 0.09, 31, 91)) | 1);
  const radius = Math.floor(windowSize / 2);
  const areaSum = (table: Float64Array, x0: number, y0: number, x1: number, y1: number) => table[y1 * integralWidth + x1]
    - table[y0 * integralWidth + x1] - table[y1 * integralWidth + x0] + table[y0 * integralWidth + x0];

  for (let y = 0; y < rgb.height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(rgb.height, y + radius + 1);
    for (let x = 0; x < rgb.width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(rgb.width, x + radius + 1);
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      const mean = areaSum(integral, x0, y0, x1, y1) / area;
      const variance = Math.max(0, areaSum(squared, x0, y0, x1, y1) / area - mean * mean);
      const deviation = Math.sqrt(variance);
      const pixel = y * rgb.width + x;
      const offset = pixel * 4;
      const luminance = grayValues[pixel];
      const threshold = mean * (1 + 0.2 * (deviation / 128 - 1));
      const normalized = clamp(242 + (luminance - mean) * 1.9, 0, 255);
      const relativeDarkness = (
        Math.max(0, 1 - source.data[offset] / background[0])
        + Math.max(0, 1 - source.data[offset + 1] / background[1])
        + Math.max(0, 1 - source.data[offset + 2] / background[2])
      ) / 3;
      const localDarkness = Math.max(0, (mean - luminance) / Math.max(28, deviation * 2.2));
      const inkValue = 255 - clamp((Math.max(relativeDarkness * 1.25, localDarkness) - 0.035) * 520, 0, 255);
      const values: Record<keyof typeof outputs, number> = {
        gray: luminance,
        contrast: normalized,
        sauvola: luminance < threshold - 1.5 ? 0 : 255,
        ink: inkValue,
      };
      for (const key of Object.keys(outputs) as Array<keyof typeof outputs>) {
        const pixels = images[key].pixels;
        if (!pixels) continue;
        const value = Math.round(values[key]);
        pixels.data[offset] = value;
        pixels.data[offset + 1] = value;
        pixels.data[offset + 2] = value;
        pixels.data[offset + 3] = 255;
      }
    }
  }
  for (const key of Object.keys(outputs) as Array<keyof typeof outputs>) {
    const target = images[key];
    if (target.context && target.pixels) target.context.putImageData(target.pixels, 0, 0);
  }
  return outputs;
}

export function estimateDeskewAngle(binary: HTMLCanvasElement) {
  const context = binary.getContext("2d", { willReadFrequently: true });
  if (!context || binary.width < 32 || binary.height < 32) return 0;
  const pixels = context.getImageData(0, 0, binary.width, binary.height).data;
  const points: OcrPoint[] = [];
  const marginX = Math.round(binary.width * 0.05);
  const marginY = Math.round(binary.height * 0.06);
  const stride = Math.max(1, Math.floor((binary.width * binary.height) / 30_000));
  for (let y = marginY; y < binary.height - marginY; y += 1) {
    for (let x = marginX; x < binary.width - marginX; x += stride) {
      if (pixels[(y * binary.width + x) * 4] < 96) points.push({ x, y });
    }
  }
  if (points.length < 24) return 0;
  const centerX = binary.width / 2;
  const score = (angle: number) => {
    const slope = Math.tan((angle * Math.PI) / 180);
    const rows = new Uint16Array(binary.height + Math.ceil(Math.abs(slope) * binary.width) + 4);
    const offset = Math.ceil(Math.abs(slope) * binary.width / 2) + 2;
    for (const point of points) {
      const row = Math.round(point.y - slope * (point.x - centerX)) + offset;
      if (row >= 0 && row < rows.length) rows[row] += 1;
    }
    let value = 0;
    for (let index = 1; index < rows.length; index += 1) value += (rows[index] - rows[index - 1]) ** 2;
    return value;
  };
  const zeroScore = score(0);
  let bestAngle = 0;
  let bestScore = zeroScore;
  for (let angle = -7; angle <= 7; angle += 0.5) {
    const current = score(angle);
    if (current > bestScore) {
      bestAngle = angle;
      bestScore = current;
    }
  }
  return Math.abs(bestAngle) >= 0.75 && bestScore >= zeroScore * 1.035 ? bestAngle : 0;
}

function rotateCanvas(source: HTMLCanvasElement, angle: number) {
  if (!angle) return source;
  const canvas = createCanvas(source.width, source.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((angle * Math.PI) / 180);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

export function prepareNoteCrops(image: HTMLImageElement, note: OcrRegion): PreparedNoteCrops {
  let rgb = rectifyNote(image, note);
  let variants = renderVariants(rgb);
  const deskewAngle = estimateDeskewAngle(variants.sauvola);
  if (deskewAngle) {
    const rotated = rotateCanvas(rgb, -deskewAngle);
    rgb.width = 1;
    rgb.height = 1;
    Object.values(variants).forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
    rgb = rotated;
    variants = renderVariants(rgb);
  }
  return { rgb, ...variants, deskewAngle };
}

export function detectTextLineBands(binary: HTMLCanvasElement): TextLineBand[] {
  const context = binary.getContext("2d", { willReadFrequently: true });
  if (!context || binary.width < 16 || binary.height < 16) return [];
  const pixels = context.getImageData(0, 0, binary.width, binary.height).data;
  const marginX = Math.round(binary.width * 0.055);
  const marginY = Math.round(binary.height * 0.065);
  const rowCounts = new Float32Array(binary.height);
  for (let y = marginY; y < binary.height - marginY; y += 1) {
    let count = 0;
    for (let x = marginX; x < binary.width - marginX; x += 1) {
      if (pixels[(y * binary.width + x) * 4] < 96) count += 1;
    }
    rowCounts[y] = count;
  }
  const smoothed = new Float32Array(binary.height);
  const smoothRadius = Math.max(1, Math.round(binary.height * 0.004));
  for (let y = marginY; y < binary.height - marginY; y += 1) {
    let total = 0;
    let count = 0;
    for (let offset = -smoothRadius; offset <= smoothRadius; offset += 1) {
      if (y + offset < 0 || y + offset >= binary.height) continue;
      total += rowCounts[y + offset];
      count += 1;
    }
    smoothed[y] = total / Math.max(1, count);
  }

  const activeThreshold = Math.max(2, (binary.width - marginX * 2) * 0.006);
  const rawBands: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let y = marginY; y <= binary.height - marginY; y += 1) {
    const active = y < binary.height - marginY && smoothed[y] >= activeThreshold;
    if (active && start < 0) start = y;
    if (!active && start >= 0) {
      rawBands.push({ start, end: y - 1 });
      start = -1;
    }
  }
  const mergeGap = Math.max(3, Math.round(binary.height * 0.018));
  const merged: Array<{ start: number; end: number }> = [];
  for (const band of rawBands) {
    const previous = merged[merged.length - 1];
    if (previous && band.start - previous.end - 1 <= mergeGap) previous.end = band.end;
    else merged.push({ ...band });
  }

  const bands: TextLineBand[] = [];
  for (const band of merged) {
    const rawHeight = band.end - band.start + 1;
    if (rawHeight < Math.max(5, binary.height * 0.012) || rawHeight > binary.height * 0.42) continue;
    const yPadding = Math.max(4, Math.round(rawHeight * 0.32));
    const top = clamp(band.start - yPadding, 0, binary.height - 1);
    const bottom = clamp(band.end + yPadding, top + 1, binary.height);
    let minX = binary.width;
    let maxX = -1;
    let darkPixels = 0;
    for (let y = band.start; y <= band.end; y += 1) {
      for (let x = marginX; x < binary.width - marginX; x += 1) {
        if (pixels[(y * binary.width + x) * 4] >= 96) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        darkPixels += 1;
      }
    }
    if (maxX < minX || darkPixels < Math.max(8, binary.width * 0.018)) continue;
    const xPadding = Math.max(10, Math.round((maxX - minX + 1) * 0.08));
    const left = clamp(minX - xPadding, 0, binary.width - 1);
    const right = clamp(maxX + xPadding, left + 1, binary.width);
    bands.push({ x: left, y: top, width: right - left, height: bottom - top, order: bands.length });
  }
  return bands.slice(0, 8);
}

export function createTextLineCrop(source: HTMLCanvasElement, band: TextLineBand, targetHeight = 96) {
  const scale = clamp(Math.min(targetHeight / band.height, 1024 / band.width), 0.75, 4);
  const border = Math.round(clamp(targetHeight * 0.12, 8, 16));
  const canvas = createCanvas(Math.max(1, Math.round(band.width * scale)) + border * 2, Math.max(1, Math.round(band.height * scale)) + border * 2);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, band.x, band.y, band.width, band.height, border, border, canvas.width - border * 2, canvas.height - border * 2);
  return canvas;
}

export function disposePreparedNoteCrops(prepared: PreparedNoteCrops) {
  const canvases = new Set([prepared.rgb, prepared.gray, prepared.contrast, prepared.sauvola, prepared.ink]);
  canvases.forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
}

"use client";

export const SIMPLE_SYMBOLS = ["♥", "↑", "↓", "←", "→", "!", "☺", "☹"] as const;

export type SimpleSymbol = (typeof SIMPLE_SYMBOLS)[number];

export const SIMPLE_SYMBOL_LABELS: Record<SimpleSymbol, string> = {
  "♥": "Herz",
  "↑": "Pfeil nach oben",
  "↓": "Pfeil nach unten",
  "←": "Pfeil nach links",
  "→": "Pfeil nach rechts",
  "!": "Ausrufezeichen",
  "☺": "Lächelnder Smiley",
  "☹": "Trauriger Smiley",
};

export type RecognizedSymbol = {
  symbol: SimpleSymbol;
  label: string;
  confidence: number;
  dominantInk?: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

type Component = Bounds & {
  id: number;
  pixels: number[];
  area: number;
};

type Candidate = {
  bounds: Bounds;
  componentIds: number[];
  pixels: number[];
  isolated: boolean;
};

type Template = {
  symbol: Exclude<SimpleSymbol, "☺" | "☹">;
  mask: Uint8Array;
  distance: Float32Array;
  inkCount: number;
};

const NORMALIZED_SIZE = 48;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function boundsWidth(bounds: Bounds) {
  return bounds.maxX - bounds.minX + 1;
}

function boundsHeight(bounds: Bounds) {
  return bounds.maxY - bounds.minY + 1;
}

function unionBounds(components: Component[]): Bounds {
  return components.reduce<Bounds>((bounds, component) => ({
    minX: Math.min(bounds.minX, component.minX),
    minY: Math.min(bounds.minY, component.minY),
    maxX: Math.max(bounds.maxX, component.maxX),
    maxY: Math.max(bounds.maxY, component.maxY),
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1 });
}

function overlapLength(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1);
}

function boxIoU(left: Bounds, right: Bounds) {
  const overlap = overlapLength(left.minX, left.maxX, right.minX, right.maxX)
    * overlapLength(left.minY, left.maxY, right.minY, right.maxY);
  const leftArea = boundsWidth(left) * boundsHeight(left);
  const rightArea = boundsWidth(right) * boundsHeight(right);
  return overlap / Math.max(1, leftArea + rightArea - overlap);
}

function denoiseMask(input: Uint8Array, width: number, height: number) {
  const output = new Uint8Array(input.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!input[index]) continue;
      let neighbors = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (input[(y + offsetY) * width + x + offsetX]) neighbors += 1;
        }
      }
      if (neighbors >= 2) output[index] = 1;
    }
  }
  return output;
}

function connectedComponents(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    visited[seed] = 1;
    stack.push(seed);
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push(index);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const nextX = x + offsetX;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    components.push({ id: components.length, pixels, area: pixels.length, minX, minY, maxX, maxY });
  }
  return components;
}

function componentCenter(component: Component) {
  return {
    x: (component.minX + component.maxX) / 2,
    y: (component.minY + component.maxY) / 2,
  };
}

function isPeerNear(component: Component, other: Component) {
  const height = boundsHeight(component);
  const otherHeight = boundsHeight(other);
  if (otherHeight < height * 0.42 || otherHeight > height * 2.35) return false;
  const verticalOverlap = overlapLength(component.minY, component.maxY, other.minY, other.maxY)
    / Math.max(1, Math.min(height, otherHeight));
  const horizontalGap = other.minX > component.maxX
    ? other.minX - component.maxX - 1
    : component.minX > other.maxX ? component.minX - other.maxX - 1 : 0;
  return verticalOverlap >= 0.35 && horizontalGap <= Math.max(height, otherHeight) * 0.38;
}

function makeCandidate(group: Component[], all: Component[]): Candidate {
  const ids = new Set(group.map((component) => component.id));
  return {
    bounds: unionBounds(group),
    componentIds: [...ids].sort((left, right) => left - right),
    pixels: [...new Set(group.flatMap((component) => component.pixels))],
    isolated: !group.some((component) => all.some((other) => !ids.has(other.id) && isPeerNear(component, other))),
  };
}

function candidateGroups(components: Component[], width: number, height: number) {
  const noteArea = width * height;
  const minimumArea = Math.max(7, Math.round(noteArea * 0.000055));
  const useful = components.filter((component) => component.area >= minimumArea);
  const groups = new Map<string, Candidate>();
  const add = (group: Component[]) => {
    const candidate = makeCandidate(group, useful);
    const key = candidate.componentIds.join(",");
    if (!groups.has(key)) groups.set(key, candidate);
  };

  for (const component of useful) {
    const componentWidth = boundsWidth(component);
    const componentHeight = boundsHeight(component);
    const longSide = Math.max(componentWidth, componentHeight);
    if (longSide >= Math.min(width, height) * 0.085 && component.area >= noteArea * 0.00045) add([component]);

    // A face is normally one enclosing stroke plus two eyes and a mouth. Those
    // strokes are disconnected, but their centers all live inside the outer box.
    if (componentWidth >= Math.min(width, height) * 0.13 && componentHeight >= Math.min(width, height) * 0.13) {
      const inside = useful.filter((other) => {
        if (other.id === component.id) return false;
        const center = componentCenter(other);
        return center.x > component.minX && center.x < component.maxX
          && center.y > component.minY && center.y < component.maxY
          && other.area <= component.area * 0.48;
      });
      if (inside.length >= 3 && inside.length <= 8) add([component, ...inside]);
    }
  }

  // Group the stem and lower dot of a handwritten exclamation mark.
  for (const stem of useful) {
    const stemWidth = boundsWidth(stem);
    const stemHeight = boundsHeight(stem);
    if (stemHeight < stemWidth * 2.05 || stemHeight < height * 0.08) continue;
    const stemCenter = componentCenter(stem);
    for (const dot of useful) {
      if (dot.id === stem.id || dot.minY <= stem.maxY) continue;
      const dotWidth = boundsWidth(dot);
      const dotHeight = boundsHeight(dot);
      const dotCenter = componentCenter(dot);
      const gap = dot.minY - stem.maxY - 1;
      if (Math.abs(dotCenter.x - stemCenter.x) <= Math.max(stemWidth, dotWidth) * 0.72
        && gap <= stemHeight * 0.5
        && dotWidth <= stemWidth * 2.25
        && dotHeight <= stemWidth * 2.5
        && dot.area <= stem.area * 0.55) add([stem, dot]);
    }
  }

  // A thin or lightly photographed heart is often broken at its notch and tip.
  // OCR then sees two vertical strokes ("11"). Keep plausible left/right halves
  // together; the stricter heart topology check below still rejects real digits.
  for (let leftIndex = 0; leftIndex < useful.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < useful.length; rightIndex += 1) {
      const left = useful[leftIndex];
      const right = useful[rightIndex];
      const leftHeight = boundsHeight(left);
      const rightHeight = boundsHeight(right);
      const verticalOverlap = overlapLength(left.minY, left.maxY, right.minY, right.maxY)
        / Math.max(1, Math.min(leftHeight, rightHeight));
      const horizontalGap = right.minX > left.maxX
        ? right.minX - left.maxX - 1
        : left.minX > right.maxX ? left.minX - right.maxX - 1 : 0;
      const combined = unionBounds([left, right]);
      const combinedWidth = boundsWidth(combined);
      const combinedHeight = boundsHeight(combined);
      const ratio = combinedWidth / Math.max(1, combinedHeight);
      const sizeRatio = Math.min(left.area, right.area) / Math.max(1, Math.max(left.area, right.area));
      if (verticalOverlap >= 0.58
        && horizontalGap <= combinedHeight * 0.28
        && ratio >= 0.56 && ratio <= 1.55
        && sizeRatio >= 0.28
        && Math.min(combinedWidth, combinedHeight) >= Math.min(width, height) * 0.075) add([left, right]);
    }
  }

  return [...groups.values()];
}

function normalizePixels(pixels: number[], bounds: Bounds, sourceWidth: number) {
  const output = new Uint8Array(NORMALIZED_SIZE * NORMALIZED_SIZE);
  const width = boundsWidth(bounds);
  const height = boundsHeight(bounds);
  const scale = 38 / Math.max(width, height);
  const drawnWidth = Math.max(1, width * scale);
  const drawnHeight = Math.max(1, height * scale);
  const offsetX = (NORMALIZED_SIZE - drawnWidth) / 2;
  const offsetY = (NORMALIZED_SIZE - drawnHeight) / 2;
  for (const index of pixels) {
    const sourceX = index % sourceWidth;
    const sourceY = Math.floor(index / sourceWidth);
    const x = Math.round(offsetX + (sourceX - bounds.minX) * scale);
    const y = Math.round(offsetY + (sourceY - bounds.minY) * scale);
    for (let offsetY2 = -1; offsetY2 <= 1; offsetY2 += 1) {
      for (let offsetX2 = -1; offsetX2 <= 1; offsetX2 += 1) {
        const targetX = x + offsetX2;
        const targetY = y + offsetY2;
        if (targetX >= 0 && targetX < NORMALIZED_SIZE && targetY >= 0 && targetY < NORMALIZED_SIZE) {
          output[targetY * NORMALIZED_SIZE + targetX] = 1;
        }
      }
    }
  }
  return output;
}

function distanceTransform(mask: Uint8Array) {
  const size = NORMALIZED_SIZE;
  const diagonal = Math.SQRT2;
  const distance = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) distance[index] = mask[index] ? 0 : 1e6;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      let value = distance[index];
      if (x) value = Math.min(value, distance[index - 1] + 1);
      if (y) value = Math.min(value, distance[index - size] + 1);
      if (x && y) value = Math.min(value, distance[index - size - 1] + diagonal);
      if (x + 1 < size && y) value = Math.min(value, distance[index - size + 1] + diagonal);
      distance[index] = value;
    }
  }
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = size - 1; x >= 0; x -= 1) {
      const index = y * size + x;
      let value = distance[index];
      if (x + 1 < size) value = Math.min(value, distance[index + 1] + 1);
      if (y + 1 < size) value = Math.min(value, distance[index + size] + 1);
      if (x + 1 < size && y + 1 < size) value = Math.min(value, distance[index + size + 1] + diagonal);
      if (x && y + 1 < size) value = Math.min(value, distance[index + size - 1] + diagonal);
      distance[index] = value;
    }
  }
  return distance;
}

function drawDisk(mask: Uint8Array, width: number, height: number, centerX: number, centerY: number, radius: number) {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) mask[y * width + x] = 1;
  }
}

function drawLine(mask: Uint8Array, width: number, height: number, fromX: number, fromY: number, toX: number, toY: number, stroke: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY) * 1.5));
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    drawDisk(mask, width, height, fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio, stroke / 2);
  }
}

function tightBounds(mask: Uint8Array, width: number, height: number): Bounds {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function normalizeTemplate(mask: Uint8Array, width: number, height: number) {
  const pixels: number[] = [];
  for (let index = 0; index < mask.length; index += 1) if (mask[index]) pixels.push(index);
  return normalizePixels(pixels, tightBounds(mask, width, height), width);
}

function makeArrowTemplate(symbol: "↑" | "↓" | "←" | "→", stroke: number, head: number) {
  const size = 64;
  const mask = new Uint8Array(size * size);
  const rotate = (x: number, y: number): [number, number] => {
    if (symbol === "→") return [x, y];
    if (symbol === "←") return [size - x, y];
    if (symbol === "↓") return [y, x];
    return [y, size - x];
  };
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    const from = rotate(x0, y0);
    const to = rotate(x1, y1);
    drawLine(mask, size, size, from[0], from[1], to[0], to[1], stroke);
  };
  segment(10, 32, 53, 32);
  segment(53, 32, 53 - head, 32 - head * 0.72);
  segment(53, 32, 53 - head, 32 + head * 0.72);
  return normalizeTemplate(mask, size, size);
}

function makeHeartTemplate(stroke: number, filled: boolean) {
  const size = 64;
  const mask = new Uint8Array(size * size);
  const points: Array<[number, number]> = [];
  for (let step = 0; step <= 180; step += 1) {
    const t = (step / 180) * Math.PI * 2;
    const x = 32 + 1.38 * 16 * Math.sin(t) ** 3;
    const y = 29 - 1.35 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    points.push([x, y]);
  }
  for (let index = 1; index < points.length; index += 1) {
    drawLine(mask, size, size, points[index - 1][0], points[index - 1][1], points[index][0], points[index][1], stroke);
  }
  if (filled) {
    for (let y = 0; y < size; y += 1) {
      const xs: number[] = [];
      for (let x = 0; x < size; x += 1) if (mask[y * size + x]) xs.push(x);
      if (xs.length >= 2) for (let x = xs[0]; x <= xs[xs.length - 1]; x += 1) mask[y * size + x] = 1;
    }
  }
  return normalizeTemplate(mask, size, size);
}

function makeExclamationTemplate(stroke: number, dotScale: number) {
  const size = 64;
  const mask = new Uint8Array(size * size);
  drawLine(mask, size, size, 32, 8, 32, 43, stroke);
  drawDisk(mask, size, size, 32, 55, stroke * dotScale);
  return normalizeTemplate(mask, size, size);
}

function buildTemplates() {
  const masks: Array<{ symbol: Template["symbol"]; mask: Uint8Array }> = [];
  for (const symbol of ["↑", "↓", "←", "→"] as const) {
    for (const stroke of [3, 5, 7]) for (const head of [15, 20]) {
      masks.push({ symbol, mask: makeArrowTemplate(symbol, stroke, head) });
    }
  }
  for (const stroke of [3, 5, 7]) masks.push({ symbol: "♥", mask: makeHeartTemplate(stroke, false) });
  masks.push({ symbol: "♥", mask: makeHeartTemplate(3, true) });
  for (const stroke of [4, 6, 8]) for (const dotScale of [0.55, 0.8]) {
    masks.push({ symbol: "!", mask: makeExclamationTemplate(stroke, dotScale) });
  }
  return masks.map(({ symbol, mask }): Template => ({
    symbol,
    mask,
    distance: distanceTransform(mask),
    inkCount: mask.reduce((sum, value) => sum + value, 0),
  }));
}

const TEMPLATES = buildTemplates();

function templateScore(source: Uint8Array, sourceDistance: Float32Array, template: Template) {
  let sourceCount = 0;
  let sourceDistanceTotal = 0;
  let sourceCovered = 0;
  let templateDistanceTotal = 0;
  let templateCovered = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index]) {
      sourceCount += 1;
      sourceDistanceTotal += template.distance[index];
      if (template.distance[index] <= 2.35) sourceCovered += 1;
    }
    if (template.mask[index]) {
      templateDistanceTotal += sourceDistance[index];
      if (sourceDistance[index] <= 2.35) templateCovered += 1;
    }
  }
  if (!sourceCount || !template.inkCount) return 0;
  const averageDistance = (sourceDistanceTotal / sourceCount + templateDistanceTotal / template.inkCount) / 2;
  const coverage = Math.sqrt((sourceCovered / sourceCount) * (templateCovered / template.inkCount));
  const densityPenalty = Math.min(0.22, Math.abs(Math.log(sourceCount / template.inkCount)) * 0.09);
  return clamp((1 - averageDistance / 7.8) * 0.58 + coverage * 0.42 - densityPenalty, 0, 1);
}

function faceFromCandidate(candidate: Candidate, components: Component[]) {
  if (candidate.componentIds.length < 4 || candidate.componentIds.length > 9) return null;
  const members = candidate.componentIds.map((id) => components.find((component) => component.id === id)).filter((component): component is Component => Boolean(component));
  const outer = members.reduce((best, component) => boundsWidth(component) * boundsHeight(component) > boundsWidth(best) * boundsHeight(best) ? component : best);
  const width = boundsWidth(outer);
  const height = boundsHeight(outer);
  const ratio = width / Math.max(1, height);
  if (ratio < 0.68 || ratio > 1.42) return null;
  const inside = members.filter((component) => component.id !== outer.id && (() => {
    const center = componentCenter(component);
    return center.x > outer.minX && center.x < outer.maxX && center.y > outer.minY && center.y < outer.maxY;
  })());
  const upper = inside.filter((component) => componentCenter(component).y < outer.minY + height * 0.58)
    .filter((component) => boundsWidth(component) <= width * 0.3 && boundsHeight(component) <= height * 0.3)
    .sort((left, right) => componentCenter(left).x - componentCenter(right).x);
  if (upper.length < 2) return null;
  let eyes: [Component, Component] | null = null;
  let bestEyeScore = -1;
  for (let leftIndex = 0; leftIndex < upper.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < upper.length; rightIndex += 1) {
    const left = upper[leftIndex];
    const right = upper[rightIndex];
    const leftCenter = componentCenter(left);
    const rightCenter = componentCenter(right);
    const separation = (rightCenter.x - leftCenter.x) / width;
    const alignment = Math.abs(leftCenter.y - rightCenter.y) / height;
    const sizeRatio = Math.min(left.area, right.area) / Math.max(1, Math.max(left.area, right.area));
    const score = separation - alignment * 1.5 + sizeRatio * 0.25;
    if (separation >= 0.18 && separation <= 0.7 && alignment <= 0.16 && score > bestEyeScore) {
      bestEyeScore = score;
      eyes = [left, right];
    }
  }
  if (!eyes) return null;
  const eyeIds = new Set(eyes.map((eye) => eye.id));
  const mouths = inside.filter((component) => !eyeIds.has(component.id)
    && componentCenter(component).y > outer.minY + height * 0.48
    && boundsWidth(component) >= width * 0.2)
    .sort((left, right) => right.area - left.area);
  const mouth = mouths[0];
  if (!mouth) return null;

  const mouthWidth = boundsWidth(mouth);
  // Curvature is computed separately because decoding component pixels needs the
  // source-image stride. This first pass only validates the face layout.
  const mouthCenter = componentCenter(mouth);
  const eyeCenterY = (componentCenter(eyes[0]).y + componentCenter(eyes[1]).y) / 2;
  if (mouthCenter.y <= eyeCenterY + height * 0.13 || mouthWidth < width * 0.2) return null;
  return {
    confidence: clamp(0.74 + bestEyeScore * 0.12 + (candidate.isolated ? 0.04 : 0), 0.74, 0.93),
    outer,
    eyes,
    mouth,
  };
}

function faceCurvature(mouth: Component, eyes: [Component, Component], sourceWidth: number) {
  const leftEye = componentCenter(eyes[0]);
  const rightEye = componentCenter(eyes[1]);
  const angle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const rotated = mouth.pixels.map((index) => {
    const x = index % sourceWidth;
    const y = Math.floor(index / sourceWidth);
    return { x: x * cosine + y * sine, y: -x * sine + y * cosine };
  });
  const minimumX = Math.min(...rotated.map((point) => point.x));
  const maximumX = Math.max(...rotated.map((point) => point.x));
  const width = maximumX - minimumX + 1;
  const samples: number[][] = [[], [], []];
  for (const point of rotated) {
    const relative = (point.x - minimumX) / Math.max(1, width - 1);
    const bucket = relative < 0.3 ? 0 : relative > 0.7 ? 2 : 1;
    samples[bucket].push(point.y);
  }
  if (samples.some((sample) => !sample.length)) return 0;
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return average(samples[1]) - (average(samples[0]) + average(samples[2])) / 2;
}

function recognizeFace(candidate: Candidate, components: Component[], sourceWidth: number) {
  const base = faceFromCandidate(candidate, components);
  if (!base) return null;
  const height = boundsHeight(base.outer);
  const curvature = faceCurvature(base.mouth, base.eyes, sourceWidth);
  if (Math.abs(curvature) < Math.max(1.1, height * 0.026)) return null;
  return {
    symbol: (curvature > 0 ? "☺" : "☹") as "☺" | "☹",
    confidence: clamp(base.confidence + Math.min(0.06, Math.abs(curvature) / height * 0.7), 0, 0.96),
  };
}

function recognizeExclamation(candidate: Candidate, components: Component[]) {
  if (candidate.componentIds.length !== 2 || !candidate.isolated) return null;
  const members = candidate.componentIds.map((id) => components.find((component) => component.id === id)).filter((component): component is Component => Boolean(component));
  if (members.length !== 2) return null;
  const ordered = [...members].sort((left, right) => left.minY - right.minY);
  const [stem, dot] = ordered;
  const stemWidth = boundsWidth(stem);
  const stemHeight = boundsHeight(stem);
  const dotWidth = boundsWidth(dot);
  const dotHeight = boundsHeight(dot);
  const xAlignment = Math.abs(componentCenter(stem).x - componentCenter(dot).x) / Math.max(stemWidth, dotWidth);
  const gap = dot.minY - stem.maxY - 1;
  if (stemHeight < stemWidth * 2.05 || dot.minY <= stem.maxY || xAlignment > 0.75
    || dotWidth > stemWidth * 2.3 || dotHeight > stemWidth * 2.55 || gap > stemHeight * 0.52) return null;
  const shape = clamp((stemHeight / Math.max(1, stemWidth) - 2) / 4, 0, 1);
  const alignment = clamp(1 - xAlignment, 0, 1);
  return { symbol: "!" as const, confidence: clamp(0.77 + shape * 0.1 + alignment * 0.07 + (candidate.isolated ? 0.03 : 0), 0, 0.97) };
}

function heartShapeScore(candidate: Candidate, sourceWidth: number) {
  const width = boundsWidth(candidate.bounds);
  const height = boundsHeight(candidate.bounds);
  const centerX = (candidate.bounds.minX + candidate.bounds.maxX) / 2;
  let leftTop = candidate.bounds.maxY;
  let rightTop = candidate.bounds.maxY;
  let centerTop = candidate.bounds.maxY;
  let bottomMinX = candidate.bounds.maxX;
  let bottomMaxX = candidate.bounds.minX;
  let bottomXTotal = 0;
  let bottomCount = 0;
  const localWidth = width + 4;
  const localHeight = height + 4;
  const localMask = new Uint8Array(localWidth * localHeight);
  for (const index of candidate.pixels) {
    const x = index % sourceWidth;
    const y = Math.floor(index / sourceWidth);
    const localX = x - candidate.bounds.minX + 2;
    const localY = y - candidate.bounds.minY + 2;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      localMask[(localY + offsetY) * localWidth + localX + offsetX] = 1;
    }
    if (x < centerX - width * 0.08) leftTop = Math.min(leftTop, y);
    if (x > centerX + width * 0.08) rightTop = Math.min(rightTop, y);
    if (Math.abs(x - centerX) <= width * 0.1) centerTop = Math.min(centerTop, y);
    if (y >= candidate.bounds.minY + height * 0.78) {
      bottomMinX = Math.min(bottomMinX, x);
      bottomMaxX = Math.max(bottomMaxX, x);
      bottomXTotal += x;
      bottomCount += 1;
    }
  }
  if (!bottomCount) return 0;
  const notchDepth = (centerTop - (leftTop + rightTop) / 2) / Math.max(1, height);
  const bottomWidth = (bottomMaxX - bottomMinX + 1) / Math.max(1, width);
  const bottomCenterOffset = Math.abs(bottomXTotal / bottomCount - centerX) / Math.max(1, width);
  const visited = new Uint8Array(localMask.length);
  const queue = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const x = current % localWidth;
    const y = Math.floor(current / localWidth);
    const neighbors = [current - 1, current + 1, current - localWidth, current + localWidth];
    for (const next of neighbors) {
      if (next < 0 || next >= localMask.length || visited[next] || localMask[next]) continue;
      const nextX = next % localWidth;
      const nextY = Math.floor(next / localWidth);
      if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) continue;
      visited[next] = 1;
      queue.push(next);
    }
  }
  let enclosed = 0;
  for (let index = 0; index < localMask.length; index += 1) if (!localMask[index] && !visited[index]) enclosed += 1;
  const density = candidate.pixels.length / Math.max(1, width * height);
  const splitOutline = candidate.componentIds.length === 2
    && notchDepth >= 0.09 && bottomWidth <= 0.38 && bottomCenterOffset <= 0.13;
  const hasHeartInterior = enclosed >= width * height * 0.025 || density >= 0.46 || splitOutline;
  if (notchDepth < 0.065 || bottomWidth > 0.52 || bottomCenterOffset > 0.16 || !hasHeartInterior) return 0;
  return clamp(0.55 + notchDepth * 1.8 + (0.52 - bottomWidth) * 0.35 - bottomCenterOffset + Math.min(0.08, enclosed / (width * height)), 0, 1);
}

function arrowTopologyScore(candidate: Candidate, sourceWidth: number, symbol: "↑" | "↓" | "←" | "→") {
  const horizontal = symbol === "←" || symbol === "→";
  const axisLength = horizontal ? boundsWidth(candidate.bounds) : boundsHeight(candidate.bounds);
  const crossLength = horizontal ? boundsHeight(candidate.bounds) : boundsWidth(candidate.bounds);
  const crossByBand: number[][] = [[], [], []];
  for (const index of candidate.pixels) {
    const x = index % sourceWidth;
    const y = Math.floor(index / sourceWidth);
    const depth = symbol === "→" ? candidate.bounds.maxX - x
      : symbol === "←" ? x - candidate.bounds.minX
        : symbol === "↑" ? y - candidate.bounds.minY
          : candidate.bounds.maxY - y;
    const normalizedDepth = depth / Math.max(1, axisLength - 1);
    const cross = horizontal ? y : x;
    const band = normalizedDepth <= 0.12 ? 0 : normalizedDepth <= 0.43 ? 1 : normalizedDepth >= 0.54 ? 2 : -1;
    if (band >= 0) crossByBand[band].push(cross);
  }
  if (crossByBand.some((values) => !values.length)) return 0;
  const span = (values: number[]) => Math.max(...values) - Math.min(...values) + 1;
  const tipSpan = span(crossByBand[0]);
  const headSpan = span(crossByBand[1]);
  const tailSpan = span(crossByBand[2]);
  if (headSpan < tipSpan * 1.2 || headSpan < tailSpan * 1.45 || headSpan < crossLength * 0.48) return 0;
  const expansion = clamp((headSpan / Math.max(1, tipSpan) - 1.2) / 1.8, 0, 1);
  const tailContrast = clamp((headSpan / Math.max(1, tailSpan) - 1.45) / 2.2, 0, 1);
  return clamp(0.62 + expansion * 0.2 + tailContrast * 0.18, 0, 1);
}

function templateClassification(candidate: Candidate, sourceWidth: number, sourceHeight: number) {
  const width = boundsWidth(candidate.bounds);
  const height = boundsHeight(candidate.bounds);
  const ratio = width / Math.max(1, height);
  const heartShape = heartShapeScore(candidate, sourceWidth);
  const normalized = normalizePixels(candidate.pixels, candidate.bounds, sourceWidth);
  const sourceDistance = distanceTransform(normalized);
  const scores = new Map<Template["symbol"], number>();
  for (const template of TEMPLATES) {
    if ((template.symbol === "←" || template.symbol === "→") && ratio < 1.08) continue;
    if ((template.symbol === "↑" || template.symbol === "↓") && ratio > 0.93) continue;
    if (template.symbol === "♥" && (ratio < 0.56 || ratio > 1.55
      || Math.min(width, height) < Math.min(sourceWidth, sourceHeight) * 0.08 || !heartShape)) continue;
    if (template.symbol === "!" && (ratio > 0.72 || candidate.componentIds.length !== 2)) continue;
    const arrowTopology = template.symbol === "↑" || template.symbol === "↓" || template.symbol === "←" || template.symbol === "→"
      ? arrowTopologyScore(candidate, sourceWidth, template.symbol)
      : 0;
    if ((template.symbol === "↑" || template.symbol === "↓" || template.symbol === "←" || template.symbol === "→") && !arrowTopology) continue;
    const structuralBoost = template.symbol === "♥" ? (heartShape - 0.55) * 0.12 : arrowTopology ? (arrowTopology - 0.62) * 0.08 : 0;
    scores.set(template.symbol, Math.max(scores.get(template.symbol) ?? 0, templateScore(normalized, sourceDistance, template) + structuralBoost));
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const best = ranked[0];
  if (!best) return null;
  const [symbol, score] = best;
  const runnerUp = ranked.find(([other]) => other !== symbol)?.[1] ?? 0;
  const threshold = symbol === "♥" ? 0.69 : symbol === "!" ? 0.76 : 0.7;
  const requiredMargin = symbol === "!" ? 0.035 : 0.055;
  if (score < threshold || score - runnerUp < requiredMargin) return null;
  if (symbol !== "!" && !candidate.isolated) return null;
  return { symbol, confidence: clamp(0.62 + (score - threshold) * 1.25 + Math.min(0.12, score - runnerUp), 0.7, 0.96) };
}

export function recognizeSimpleSymbols(input: Uint8Array, width: number, height: number): RecognizedSymbol[] {
  if (width < 20 || height < 20 || input.length < width * height) return [];
  const mask = denoiseMask(input, width, height);
  const noteArea = width * height;
  const components = connectedComponents(mask, width, height)
    .filter((component) => component.area >= Math.max(7, noteArea * 0.000055));
  if (!components.length) return [];
  const minimumLongSide = Math.min(width, height) * 0.085;
  const usefulInk = components.reduce((sum, component) => sum + component.area, 0);
  const detected: Array<{ symbol: SimpleSymbol; confidence: number; bounds: Bounds; dominantInk: number }> = [];
  for (const candidate of candidateGroups(components, width, height)) {
    const candidateWidth = boundsWidth(candidate.bounds);
    const candidateHeight = boundsHeight(candidate.bounds);
    if (Math.max(candidateWidth, candidateHeight) < minimumLongSide) continue;
    const face = recognizeFace(candidate, components, width);
    const exclamation = recognizeExclamation(candidate, components);
    const template = templateClassification(candidate, width, height);
    const options = [face, exclamation, template].filter((value): value is { symbol: SimpleSymbol; confidence: number } => Boolean(value));
    const selected = options.sort((left, right) => right.confidence - left.confidence)[0];
    if (selected) detected.push({
      ...selected,
      bounds: candidate.bounds,
      dominantInk: clamp(candidate.pixels.length / Math.max(1, usefulInk), 0, 1),
    });
  }

  const kept: typeof detected = [];
  for (const current of detected.sort((left, right) => right.confidence - left.confidence)) {
    const duplicate = kept.some((existing) => boxIoU(existing.bounds, current.bounds) >= 0.42);
    if (!duplicate) kept.push(current);
  }
  return kept
    .sort((left, right) => Math.abs(left.bounds.minY - right.bounds.minY) <= height * 0.08
      ? left.bounds.minX - right.bounds.minX
      : left.bounds.minY - right.bounds.minY)
    .slice(0, 8)
    .map((entry) => ({
      symbol: entry.symbol,
      label: SIMPLE_SYMBOL_LABELS[entry.symbol],
      confidence: Math.round(entry.confidence * 100),
      dominantInk: entry.dominantInk,
      x: entry.bounds.minX / width,
      y: entry.bounds.minY / height,
      width: boundsWidth(entry.bounds) / width,
      height: boundsHeight(entry.bounds) / height,
    }));
}

function canvasInkMask(canvas: HTMLCanvasElement, threshold: number) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width < 20 || canvas.height < 20) return null;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const mask = new Uint8Array(canvas.width * canvas.height);
  const marginX = Math.round(canvas.width * 0.035);
  const marginY = Math.round(canvas.height * 0.04);
  for (let y = marginY; y < canvas.height - marginY; y += 1) {
    for (let x = marginX; x < canvas.width - marginX; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] < threshold) mask[y * canvas.width + x] = 1;
    }
  }
  return mask;
}

export function recognizeSimpleSymbolsFromCanvas(canvas: HTMLCanvasElement, threshold = 112) {
  const mask = canvasInkMask(canvas, threshold);
  return mask ? recognizeSimpleSymbols(mask, canvas.width, canvas.height) : [];
}

function detectionIoU(left: RecognizedSymbol, right: RecognizedSymbol) {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const overlap = overlapWidth * overlapHeight;
  return overlap / Math.max(1e-6, left.width * left.height + right.width * right.height - overlap);
}

export function fuseSymbolDetections(
  sauvolaDetections: RecognizedSymbol[],
  inkDetections: RecognizedSymbol[],
) {
  const fused: RecognizedSymbol[] = [];
  const usedInk = new Set<number>();
  for (const first of sauvolaDetections) {
    let best: { detection: RecognizedSymbol; index: number; overlap: number } | null = null;
    for (let index = 0; index < inkDetections.length; index += 1) {
      const second = inkDetections[index];
      if (usedInk.has(index) || first.symbol !== second.symbol) continue;
      const overlap = detectionIoU(first, second);
      const firstCenter = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
      const secondCenter = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
      const centerDistance = Math.hypot(firstCenter.x - secondCenter.x, firstCenter.y - secondCenter.y);
      if (overlap < 0.34 && centerDistance > 0.075) continue;
      if (!best || overlap > best.overlap) best = { detection: second, index, overlap };
    }
    if (!best) continue;
    usedInk.add(best.index);
    const second = best.detection;
    const minimumConfidence = Math.min(first.confidence, second.confidence);
    const maximumConfidence = Math.max(first.confidence, second.confidence);
    const confidence = Math.round(clamp(minimumConfidence * 0.4 + maximumConfidence * 0.25 + best.overlap * 20 + 15, 0, 97));
    if (confidence < 82) continue;
    fused.push({
      ...first,
      confidence,
      dominantInk: Math.min(first.dominantInk ?? 1, second.dominantInk ?? 1),
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      width: (first.width + second.width) / 2,
      height: (first.height + second.height) / 2,
    });
  }
  return fused.sort((left, right) => Math.abs(left.y - right.y) <= 0.08 ? left.x - right.x : left.y - right.y).slice(0, 8);
}

export function fuseSymbolDetectionSets(detectionSets: RecognizedSymbol[][]) {
  if (detectionSets.length < 2) return detectionSets[0] ?? [];
  const candidates: RecognizedSymbol[] = [];
  for (let left = 0; left < detectionSets.length; left += 1) {
    for (let right = left + 1; right < detectionSets.length; right += 1) {
      candidates.push(...fuseSymbolDetections(detectionSets[left], detectionSets[right]));
    }
  }

  // A single extremely strong, dominant heart may survive only one threshold.
  // Keep it only if no other filter sees a conflicting symbol at the same place.
  detectionSets.forEach((detections, sourceIndex) => detections.forEach((detection) => {
    if (detection.symbol !== "♥" || detection.confidence < 92 || (detection.dominantInk ?? 0) < 0.78) return;
    const peers = detectionSets.flatMap((set, index) => index === sourceIndex ? [] : set)
      .filter((peer) => detectionIoU(detection, peer) >= 0.24);
    if (peers.some((peer) => peer.symbol !== detection.symbol)) return;
    if (!peers.some((peer) => peer.symbol === detection.symbol)) {
      candidates.push({ ...detection, confidence: Math.min(89, detection.confidence - 3) });
    }
  }));

  const kept: RecognizedSymbol[] = [];
  for (const candidate of candidates.sort((left, right) => right.confidence - left.confidence)) {
    if (!kept.some((existing) => existing.symbol === candidate.symbol && detectionIoU(existing, candidate) >= 0.38)) kept.push(candidate);
  }
  return kept.sort((left, right) => Math.abs(left.y - right.y) <= 0.08 ? left.x - right.x : left.y - right.y).slice(0, 8);
}

export function recognizeSimpleSymbolsFromCanvases(sauvola: HTMLCanvasElement, ink: HTMLCanvasElement, contrast?: HTMLCanvasElement) {
  if (sauvola.width !== ink.width || sauvola.height !== ink.height) return [];
  const sauvolaMask = canvasInkMask(sauvola, 112);
  const inkMask = canvasInkMask(ink, 168);
  if (!sauvolaMask || !inkMask) return [];
  const sets = [
    recognizeSimpleSymbols(sauvolaMask, sauvola.width, sauvola.height),
    recognizeSimpleSymbols(inkMask, ink.width, ink.height),
  ];
  if (contrast && contrast.width === sauvola.width && contrast.height === sauvola.height) {
    const contrastMask = canvasInkMask(contrast, 146);
    if (contrastMask) sets.push(recognizeSimpleSymbols(contrastMask, contrast.width, contrast.height));
  }
  return fuseSymbolDetectionSets(sets);
}

export function mergeRecognizedSymbols(text: string, symbols: RecognizedSymbol[]) {
  const normalized = text.trim();
  if (!symbols.length) return normalized;
  const remainingBySymbol = new Map<SimpleSymbol, number>();
  for (const symbol of symbols) remainingBySymbol.set(symbol.symbol, (remainingBySymbol.get(symbol.symbol) ?? 0) + 1);
  for (const symbol of SIMPLE_SYMBOLS) {
    const alreadyPresent = [...normalized].filter((character) => character === symbol).length;
    remainingBySymbol.set(symbol, Math.max(0, (remainingBySymbol.get(symbol) ?? 0) - alreadyPresent));
  }
  const additions: string[] = [];
  for (const detected of symbols) {
    const remaining = remainingBySymbol.get(detected.symbol) ?? 0;
    if (!remaining) continue;
    additions.push(detected.symbol);
    remainingBySymbol.set(detected.symbol, remaining - 1);
  }
  if (!additions.length) return normalized;
  return normalized ? `${normalized}\n${additions.join(" ")}` : additions.join(" ");
}

export function reconcileRecognizedSymbols(text: string, symbols: RecognizedSymbol[]) {
  const normalized = text.trim();
  const strongHearts = symbols.filter((symbol) => symbol.symbol === "♥"
    && symbol.confidence >= 88 && (symbol.dominantInk ?? 0) >= 0.75);
  const heartConfusion = /^(?:1[\s\n]*1|I[\s\n]*I|l[\s\n]*l|[Il1][\s\n]*[Il1]|[VvWw]|<\s*3)$/u;
  if (symbols.length === 1 && strongHearts.length === 1 && heartConfusion.test(normalized)) return "♥";
  return mergeRecognizedSymbols(normalized, symbols);
}

export function appendManualSymbol(text: string, symbol: SimpleSymbol) {
  if (!text) return symbol;
  return /\s$/u.test(text) ? `${text}${symbol}` : `${text} ${symbol}`;
}

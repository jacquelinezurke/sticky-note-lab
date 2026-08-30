export type ColorComponent = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
  cluster: number;
  /** Fraction of the axis-aligned component box occupied by this island. */
  fill?: number;
  /** Median Lab contrast around the component, supplied by the colour detector. */
  ringContrast?: number;
  /** True only for a high-fill component that already looks like one paper rectangle. */
  complete?: boolean;
};

export type PixelPoint = { x: number; y: number };
export type PixelQuad = [PixelPoint, PixelPoint, PixelPoint, PixelPoint];

export type NoteGeometry = ColorComponent & {
  corners?: PixelQuad;
  overlapScore?: number;
  geometryEvidence?: "complete" | "occlusion-edges";
};

type RectangleCandidate = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
  visible: number;
  boundary: number;
  adjacent: number;
  sideScores: [number, number, number, number];
};

type CandidateShape = Omit<RectangleCandidate, "score" | "visible" | "boundary" | "adjacent" | "sideScores">;

type ComponentMask = {
  pixels: number[];
  membership: Uint8Array;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function componentWidth(component: ColorComponent) {
  return component.maxX - component.minX + 1;
}

function componentHeight(component: ColorComponent) {
  return component.maxY - component.minY + 1;
}

function rectanglePoint(candidate: CandidateShape, u: number, v: number) {
  const cosine = Math.cos(candidate.angle);
  const sine = Math.sin(candidate.angle);
  return {
    x: candidate.cx + u * candidate.width * cosine - v * candidate.height * sine,
    y: candidate.cy + u * candidate.width * sine + v * candidate.height * cosine,
  };
}

function rectangleCorners(candidate: CandidateShape): PixelQuad {
  return [
    rectanglePoint(candidate, -0.5, -0.5),
    rectanglePoint(candidate, 0.5, -0.5),
    rectanglePoint(candidate, 0.5, 0.5),
    rectanglePoint(candidate, -0.5, 0.5),
  ];
}

function angleDifference(left: number, right: number) {
  const halfTurn = Math.PI / 2;
  const difference = Math.abs(left - right) % halfTurn;
  return Math.min(difference, halfTurn - difference);
}

function pointInside(candidate: CandidateShape, x: number, y: number) {
  const offsetX = x - candidate.cx;
  const offsetY = y - candidate.cy;
  const cosine = Math.cos(candidate.angle);
  const sine = Math.sin(candidate.angle);
  const localX = offsetX * cosine + offsetY * sine;
  const localY = -offsetX * sine + offsetY * cosine;
  return Math.abs(localX) <= candidate.width / 2 && Math.abs(localY) <= candidate.height / 2;
}

function boxCorners(component: ColorComponent): PixelQuad {
  return [
    { x: component.minX, y: component.minY },
    { x: component.maxX, y: component.minY },
    { x: component.maxX, y: component.maxY },
    { x: component.minX, y: component.maxY },
  ];
}

function polygonArea(points: PixelPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function signedPolygonArea(points: PixelPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function lineIntersection(start: PixelPoint, end: PixelPoint, clipStart: PixelPoint, clipEnd: PixelPoint) {
  const x1 = start.x;
  const y1 = start.y;
  const x2 = end.x;
  const y2 = end.y;
  const x3 = clipStart.x;
  const y3 = clipStart.y;
  const x4 = clipEnd.x;
  const y4 = clipEnd.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 1e-8) return end;
  return {
    x: ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator,
    y: ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator,
  };
}

function polygonIntersection(subject: PixelPoint[], rawClip: PixelPoint[]) {
  let output = [...subject];
  const clip = signedPolygonArea(rawClip) >= 0 ? rawClip : [...rawClip].reverse();
  for (let edge = 0; edge < clip.length && output.length; edge += 1) {
    const clipStart = clip[edge];
    const clipEnd = clip[(edge + 1) % clip.length];
    const input = output;
    output = [];
    const inside = (point: PixelPoint) => (clipEnd.x - clipStart.x) * (point.y - clipStart.y)
      - (clipEnd.y - clipStart.y) * (point.x - clipStart.x) >= -1e-6;
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside !== previousInside) output.push(lineIntersection(previous, current, clipStart, clipEnd));
      if (currentInside) output.push(current);
    }
  }
  return output;
}

function quadIoU(left: PixelQuad, right: PixelQuad) {
  const intersection = polygonArea(polygonIntersection(left, right));
  const union = polygonArea(left) + polygonArea(right) - intersection;
  return union > 0 ? intersection / union : 0;
}

function quadContainment(left: PixelQuad, right: PixelQuad) {
  const intersection = polygonArea(polygonIntersection(left, right));
  return intersection / Math.max(1, Math.min(polygonArea(left), polygonArea(right)));
}

/** Rebuild only the connected island represented by this component. */
function extractComponentMask(
  component: ColorComponent,
  labels: Uint8Array,
  maskWidth: number,
  maskHeight: number,
): ComponentMask {
  const visited = new Uint8Array(labels.length);
  const queue = new Int32Array(Math.max(1, componentWidth(component) * componentHeight(component)));
  let bestPixels: number[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = component.minY; y <= component.maxY; y += 1) {
    for (let x = component.minX; x <= component.maxX; x += 1) {
      const start = y * maskWidth + x;
      if (visited[start] || labels[start] !== component.cluster) continue;
      let head = 0;
      let tail = 1;
      queue[0] = start;
      visited[start] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (head < tail) {
        const current = queue[head];
        head += 1;
        const currentX = current % maskWidth;
        const currentY = Math.floor(current / maskWidth);
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (!offsetX && !offsetY) continue;
            const neighborX = currentX + offsetX;
            const neighborY = currentY + offsetY;
            if (neighborX < component.minX || neighborX > component.maxX
              || neighborY < component.minY || neighborY > component.maxY
              || neighborX < 0 || neighborY < 0 || neighborX >= maskWidth || neighborY >= maskHeight) continue;
            const neighbor = neighborY * maskWidth + neighborX;
            if (visited[neighbor] || labels[neighbor] !== component.cluster) continue;
            visited[neighbor] = 1;
            queue[tail] = neighbor;
            tail += 1;
          }
        }
      }
      const boundsDistance = Math.abs(minX - component.minX) + Math.abs(maxX - component.maxX)
        + Math.abs(minY - component.minY) + Math.abs(maxY - component.maxY);
      const countDistance = Math.abs(tail - component.count) / Math.max(1, component.count);
      const distance = boundsDistance * 4 + countDistance;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPixels = Array.from(queue.slice(0, tail));
      }
    }
  }
  const membership = new Uint8Array(labels.length);
  bestPixels.forEach((pixel) => { membership[pixel] = 1; });
  return { pixels: bestPixels, membership };
}

function maskAt(membership: Uint8Array, width: number, height: number, x: number, y: number) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  return roundedX >= 0 && roundedY >= 0 && roundedX < width && roundedY < height
    ? membership[roundedY * width + roundedX]
    : 0;
}

function sidePointAndNormal(candidate: CandidateShape, side: number, along: number) {
  const cosine = Math.cos(candidate.angle);
  const sine = Math.sin(candidate.angle);
  const localNormal = side === 0 ? { x: 0, y: 1 }
    : side === 1 ? { x: -1, y: 0 }
      : side === 2 ? { x: 0, y: -1 }
        : { x: 1, y: 0 };
  const normal = {
    x: localNormal.x * cosine - localNormal.y * sine,
    y: localNormal.x * sine + localNormal.y * cosine,
  };
  const point = side === 0 ? rectanglePoint(candidate, along, -0.5)
    : side === 1 ? rectanglePoint(candidate, 0.5, along)
      : side === 2 ? rectanglePoint(candidate, along, 0.5)
        : rectanglePoint(candidate, -0.5, along);
  return { point, normal };
}

function scoreRectangle(
  membership: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  candidate: CandidateShape,
  edgeStrength?: Float32Array,
): RectangleCandidate {
  let visibleSamples = 0;
  const interiorGrid = 7;
  for (let row = 0; row < interiorGrid; row += 1) {
    for (let column = 0; column < interiorGrid; column += 1) {
      const u = -0.4 + column * (0.8 / (interiorGrid - 1));
      const v = -0.4 + row * (0.8 / (interiorGrid - 1));
      const point = rectanglePoint(candidate, u, v);
      visibleSamples += maskAt(membership, maskWidth, maskHeight, point.x, point.y);
    }
  }
  const visible = visibleSamples / (interiorGrid * interiorGrid);

  const sideScores: number[] = [];
  const edgeSamples = 13;
  const searchRadius = clamp(Math.round(Math.min(candidate.width, candidate.height) * 0.035), 1, 3);
  for (let side = 0; side < 4; side += 1) {
    let support = 0;
    for (let sample = 0; sample < edgeSamples; sample += 1) {
      const along = -0.43 + sample * (0.86 / (edgeSamples - 1));
      const { point, normal } = sidePointAndNormal(candidate, side, along);
      let transition = false;
      let rawEdge = 0;
      for (let shift = -searchRadius; shift <= searchRadius; shift += 1) {
        const boundaryX = point.x + normal.x * shift;
        const boundaryY = point.y + normal.y * shift;
        const inner = maskAt(membership, maskWidth, maskHeight, boundaryX + normal.x * 1.35, boundaryY + normal.y * 1.35);
        const outer = maskAt(membership, maskWidth, maskHeight, boundaryX - normal.x * 1.35, boundaryY - normal.y * 1.35);
        transition ||= inner === 1 && outer === 0;
        if (edgeStrength) {
          const edgeX = Math.round(boundaryX);
          const edgeY = Math.round(boundaryY);
          if (edgeX >= 0 && edgeY >= 0 && edgeX < maskWidth && edgeY < maskHeight) {
            rawEdge = Math.max(rawEdge, edgeStrength[edgeY * maskWidth + edgeX]);
          }
        }
      }
      // A colour-owned transition is the primary cue. A continuous raw RGB
      // edge adds independent support and can recover a same-colour overlap.
      support += transition ? 0.72 + rawEdge * 0.28 : rawEdge * 0.5;
    }
    sideScores.push(support / edgeSamples);
  }

  const typedSides = sideScores as [number, number, number, number];
  const sortedSides = [...sideScores].sort((left, right) => right - left);
  const boundary = (sortedSides[0] + sortedSides[1] + sortedSides[2] * 0.55) / 2.55;
  const adjacent = Math.max(
    Math.min(sideScores[0], sideScores[1]) * 0.68 + (sideScores[0] + sideScores[1]) * 0.16,
    Math.min(sideScores[1], sideScores[2]) * 0.68 + (sideScores[1] + sideScores[2]) * 0.16,
    Math.min(sideScores[2], sideScores[3]) * 0.68 + (sideScores[2] + sideScores[3]) * 0.16,
    Math.min(sideScores[3], sideScores[0]) * 0.68 + (sideScores[3] + sideScores[0]) * 0.16,
  );
  const thirdSide = sortedSides[2];
  return {
    ...candidate,
    visible,
    boundary,
    adjacent,
    sideScores: typedSides,
    score: adjacent * 0.42 + boundary * 0.27 + visible * 0.19 + thirdSide * 0.12,
  };
}

function dominantRectangleAngles(
  component: ColorComponent,
  membership: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  baseShortSide: number,
  edgeStrength?: Float32Array,
) {
  const boundary: PixelPoint[] = [];
  for (let y = Math.max(1, component.minY); y <= Math.min(maskHeight - 2, component.maxY); y += 1) {
    for (let x = Math.max(1, component.minX); x <= Math.min(maskWidth - 2, component.maxX); x += 1) {
      const index = y * maskWidth + x;
      const onMaskBoundary = membership[index] && (!membership[index - 1] || !membership[index + 1]
        || !membership[index - maskWidth] || !membership[index + maskWidth]);
      // RGB edges are useful at same-colour overlaps, but handwriting is also a
      // strong RGB edge. Admit raw edges only in a narrow band around the colour
      // island boundary so an internal word cannot become the note's rotation.
      let hasMask = false;
      let hasOutside = false;
      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const sampleX = x + offsetX;
          const sampleY = y + offsetY;
          if (sampleX < 0 || sampleY < 0 || sampleX >= maskWidth || sampleY >= maskHeight) {
            hasOutside = true;
          } else if (membership[sampleY * maskWidth + sampleX]) hasMask = true;
          else hasOutside = true;
        }
      }
      const onRawEdge = hasMask && hasOutside && (edgeStrength?.[index] ?? 0) >= 0.2;
      if (onMaskBoundary || onRawEdge) boundary.push({ x, y });
    }
  }
  const minimumLine = Math.max(10, baseShortSide * 0.22);
  const coherentSegments = (tangentAngle: number) => {
    const radians = tangentAngle * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const buckets = new Map<number, number[]>();
    for (const point of boundary) {
      const along = point.x * cosine + point.y * sine;
      const rho = Math.round((-point.x * sine + point.y * cosine) / 2);
      const values = buckets.get(rho);
      if (values) values.push(along);
      else buckets.set(rho, [along]);
    }
    const segments: Array<{ rho: number; score: number }> = [];
    for (const [rho, values] of buckets) {
      if (values.length < 5) continue;
      values.sort((left, right) => left - right);
      let start = values[0];
      let previous = values[0];
      let samples = 1;
      let best = 0;
      for (let index = 1; index <= values.length; index += 1) {
        const value = values[index];
        if (index < values.length && value - previous <= 4.5) {
          previous = value;
          samples += 1;
          continue;
        }
        const span = previous - start;
        const density = samples / Math.max(1, span);
        if (span >= minimumLine) best = Math.max(best, span * clamp(density / 0.42, 0, 1));
        start = value;
        previous = value;
        samples = 1;
      }
      if (best) segments.push({ rho, score: best });
    }
    const independent: number[] = [];
    for (const segment of segments.sort((left, right) => right.score - left.score)) {
      if (independent.length >= 4) break;
      if (segments.some((other) => other !== segment && other.score > segment.score && Math.abs(other.rho - segment.rho) <= 1)) continue;
      independent.push(segment.score);
    }
    return independent;
  };
  const ranked: Array<{ value: number; angle: number }> = [];
  for (let angle = -45; angle < 45; angle += 2.5) {
    const parallel = coherentSegments(angle);
    const perpendicular = coherentSegments(angle + 90);
    // A rectangular orientation needs evidence from both perpendicular side
    // families. The former implementation inspected only one family and often
    // mistook a diagonal word/occluder edge for the note rotation.
    const parallelScore = (parallel[0] ?? 0) + (parallel[1] ?? 0) * 0.65;
    const perpendicularScore = (perpendicular[0] ?? 0) + (perpendicular[1] ?? 0) * 0.65;
    const value = Math.min(parallelScore, perpendicularScore) * 1.15
      + Math.max(parallelScore, perpendicularScore) * 0.35
      + (parallel[2] ?? 0) * 0.22 + (perpendicular[2] ?? 0) * 0.22;
    ranked.push({ value, angle });
  }
  ranked.sort((left, right) => right.value - left.value);
  const selected: number[] = [];
  for (const candidate of ranked) {
    if (selected.length >= 4) break;
    if (selected.some((angle) => Math.abs(angle - candidate.angle) < 6
      || Math.abs(Math.abs(angle - candidate.angle) - 90) < 6)) continue;
    selected.push(candidate.angle);
  }
  if (!selected.some((angle) => Math.abs(angle) <= 4)) selected.push(0);
  return selected.map((angle) => angle * Math.PI / 180);
}

function candidateSizes(baseShortSide: number, baseLongSide: number, allowWideFormats: boolean) {
  const aspect = clamp(baseLongSide / Math.max(1, baseShortSide), 1, 1.42);
  const geometricSide = Math.sqrt(baseLongSide * baseShortSide);
  const shapes = [
    [geometricSide, geometricSide],
    [geometricSide * Math.sqrt(aspect), geometricSide / Math.sqrt(aspect)],
    [geometricSide / Math.sqrt(aspect), geometricSide * Math.sqrt(aspect)],
  ];
  if (allowWideFormats) {
    // A multi-note island may contain the wider 3×4 format. For a one-note
    // island with a long colour tail this format would bridge paper and shadow.
    shapes.push(
      [geometricSide * Math.sqrt(1.55), geometricSide / Math.sqrt(1.55)],
      [geometricSide / Math.sqrt(1.55), geometricSide * Math.sqrt(1.55)],
    );
  }
  const result: Array<[number, number]> = [];
  for (const scale of [0.88, 1.04, 1.16]) {
    for (const [width, height] of shapes) result.push([width * scale, height * scale]);
  }
  return result;
}

function fitCompleteComponent(
  component: ColorComponent,
  componentMask: ComponentMask,
  maskWidth: number,
  maskHeight: number,
  baseShortSide: number,
  baseLongSide: number,
  edgeStrength?: Float32Array,
): NoteGeometry | null {
  if (!componentMask.pixels.length) return null;
  const coherentAngles = dominantRectangleAngles(component, componentMask.membership, maskWidth, maskHeight, baseShortSide, edgeStrength);
  const angles = Array.from({ length: 36 }, (_, index) => (-45 + index * 2.5) * Math.PI / 180)
    .sort((left, right) => {
      const leftCoherence = Math.min(...coherentAngles.map((angle) => angleDifference(left, angle)));
      const rightCoherence = Math.min(...coherentAngles.map((angle) => angleDifference(right, angle)));
      return leftCoherence - rightCoherence;
    });
  let best: { candidate: RectangleCandidate; rank: number } | null = null;
  for (const angle of angles) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    let minimumU = Number.POSITIVE_INFINITY;
    let maximumU = Number.NEGATIVE_INFINITY;
    let minimumV = Number.POSITIVE_INFINITY;
    let maximumV = Number.NEGATIVE_INFINITY;
    for (const pixel of componentMask.pixels) {
      const x = pixel % maskWidth;
      const y = Math.floor(pixel / maskWidth);
      const u = x * cosine + y * sine;
      const v = -x * sine + y * cosine;
      minimumU = Math.min(minimumU, u);
      maximumU = Math.max(maximumU, u);
      minimumV = Math.min(minimumV, v);
      maximumV = Math.max(maximumV, v);
    }
    const width = maximumU - minimumU + 1;
    const height = maximumV - minimumV + 1;
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    if (shortSide < baseShortSide * 0.38 || longSide > baseLongSide * 1.65) continue;
    const centerU = (minimumU + maximumU) / 2;
    const centerV = (minimumV + maximumV) / 2;
    const scored = scoreRectangle(componentMask.membership, maskWidth, maskHeight, {
      cx: centerU * cosine - centerV * sine,
      cy: centerU * sine + centerV * cosine,
      width,
      height,
      angle,
    }, edgeStrength);
    const rectangularFill = componentMask.pixels.length / Math.max(1, width * height);
    const strongSides = scored.sideScores.filter((side) => side >= 0.36).length;
    const supported = strongSides >= 3
      || (strongSides >= 2 && scored.adjacent >= 0.48 && rectangularFill >= 0.52)
      || (component.complete === true && rectangularFill >= 0.58 && scored.boundary >= 0.32);
    if (!supported) continue;
    const coherent = coherentAngles.some((coherentAngle) => angleDifference(angle, coherentAngle) <= 4 * Math.PI / 180) ? 1 : 0;
    const sizeRatio = Math.sqrt(width * height / Math.max(1, baseShortSide * baseLongSide));
    const sizePenalty = Math.abs(Math.log(clamp(sizeRatio, 0.25, 4))) * 0.08;
    const rank = scored.score * 0.34 + Math.min(1, rectangularFill) * 0.58 + coherent * 0.08 - sizePenalty;
    if (!best || rank > best.rank) best = { candidate: scored, rank };
  }
  if (!best) return null;
  const corners = rectangleCorners(best.candidate).map((point) => ({
    x: clamp(point.x, 0, maskWidth - 1),
    y: clamp(point.y, 0, maskHeight - 1),
  })) as PixelQuad;
  return {
    ...component,
    minX: Math.floor(Math.min(...corners.map((point) => point.x))),
    maxX: Math.ceil(Math.max(...corners.map((point) => point.x))),
    minY: Math.floor(Math.min(...corners.map((point) => point.y))),
    maxY: Math.ceil(Math.max(...corners.map((point) => point.y))),
    complete: true,
    corners,
    overlapScore: best.candidate.score,
    geometryEvidence: "complete",
  };
}

function scanOccludedComponent(
  component: ColorComponent,
  componentMask: ComponentMask,
  maskWidth: number,
  maskHeight: number,
  baseShortSide: number,
  baseLongSide: number,
  typicalVisiblePixels: number,
  edgeStrength?: Float32Array,
) {
  const typicalPaperArea = typicalVisiblePixels / 0.84;
  const limit = clamp(Math.round(componentMask.pixels.length / Math.max(1, typicalPaperArea)), 1, 7);
  const sizes = candidateSizes(baseShortSide, baseLongSide, limit > 1);
  const angles = dominantRectangleAngles(component, componentMask.membership, maskWidth, maskHeight, baseShortSide, edgeStrength);
  const gridStep = Math.max(6, Math.round(baseShortSide * 0.11));
  const centerMargin = baseShortSide * 0.14;
  const candidates: RectangleCandidate[] = [];

  for (let cy = component.minY - centerMargin; cy <= component.maxY + centerMargin; cy += gridStep) {
    for (let cx = component.minX - centerMargin; cx <= component.maxX + centerMargin; cx += gridStep) {
      let nearby = 0;
      for (const offsetY of [-0.2, 0, 0.2]) {
        for (const offsetX of [-0.2, 0, 0.2]) {
          nearby += maskAt(componentMask.membership, maskWidth, maskHeight, cx + offsetX * baseShortSide, cy + offsetY * baseShortSide);
        }
      }
      if (nearby < 2) continue;
      for (const [candidateWidth, candidateHeight] of sizes) {
        for (const angle of angles) {
          const scored = scoreRectangle(componentMask.membership, maskWidth, maskHeight, {
            cx,
            cy,
            width: candidateWidth,
            height: candidateHeight,
            angle,
          }, edgeStrength);
          const strongSides = scored.sideScores.filter((side) => side >= 0.28).length;
          if (scored.visible >= 0.2
            && strongSides >= 3
            && scored.adjacent >= 0.31
            && scored.boundary >= 0.31
            && scored.score >= 0.34) candidates.push(scored);
        }
      }
    }
  }

  // Pixel-exact coverage is relatively expensive. Edge score is a safe first
  // stage, so only the strongest geometries enter the exact selection pass.
  const scoredWithCoverage = candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 140)
    .map((candidate) => {
    let covered = 0;
    for (const pixel of componentMask.pixels) {
      const x = pixel % maskWidth;
      const y = Math.floor(pixel / maskWidth);
      if (pointInside(candidate, x, y)) covered += 1;
    }
    const coverage = covered / Math.max(1, componentMask.pixels.length);
    // A real visible paper lobe should explain a coherent chunk of its colour
    // island. This prevents a sharp but small shadow/tinted-background corner
    // from outranking the actual note (for example, a dense overlap's left tail).
    const rank = candidate.score * 0.6 + candidate.visible * 0.2 + Math.min(0.2, coverage * 0.3);
    return { candidate, covered, rank };
    }).sort((left, right) => right.rank - left.rank);

  const explained = new Uint8Array(componentMask.membership.length);
  const selected: RectangleCandidate[] = [];
  // Estimate instances from learned full paper area. Dividing by an arbitrary
  // "visible fraction" used to turn one occluded note into two to six crops.

  for (const { candidate, covered } of scoredWithCoverage) {
    if (selected.length >= limit) break;
    const corners = rectangleCorners(candidate);
    const duplicate = selected.some((other) => {
      const otherCorners = rectangleCorners(other);
      const intersection = quadIoU(corners, otherCorners);
      const containment = quadContainment(corners, otherCorners);
      const centerDistance = Math.hypot(candidate.cx - other.cx, candidate.cy - other.cy);
      const minimumSide = Math.min(candidate.width, candidate.height, other.width, other.height);
      return (containment >= 0.68 && centerDistance <= minimumSide * 0.44
          && angleDifference(candidate.angle, other.angle) <= 12 * Math.PI / 180)
        || (intersection >= 0.7 && angleDifference(candidate.angle, other.angle) <= 11 * Math.PI / 180)
        || (intersection >= 0.58 && centerDistance <= minimumSide * 0.14
          && angleDifference(candidate.angle, other.angle) <= 7 * Math.PI / 180);
    });
    if (duplicate) continue;

    let fresh = 0;
    for (const pixel of componentMask.pixels) {
      if (explained[pixel]) continue;
      const x = pixel % maskWidth;
      const y = Math.floor(pixel / maskWidth);
      if (pointInside(candidate, x, y)) fresh += 1;
    }
    const requiredFresh = selected.length
      ? Math.max(componentMask.pixels.length * 0.075, covered * 0.38)
      : Math.max(componentMask.pixels.length * 0.1, typicalVisiblePixels * 0.12);
    if (fresh < requiredFresh || covered < typicalVisiblePixels * 0.16) continue;
    selected.push(candidate);
    for (const pixel of componentMask.pixels) {
      if (pointInside(candidate, pixel % maskWidth, Math.floor(pixel / maskWidth))) explained[pixel] = 1;
    }
  }

  return selected.map((candidate): NoteGeometry => {
    const corners = rectangleCorners(candidate).map((point) => ({
      x: clamp(point.x, 0, maskWidth - 1),
      y: clamp(point.y, 0, maskHeight - 1),
    })) as PixelQuad;
    return {
      minX: Math.floor(Math.min(...corners.map((point) => point.x))),
      maxX: Math.ceil(Math.max(...corners.map((point) => point.x))),
      minY: Math.floor(Math.min(...corners.map((point) => point.y))),
      maxY: Math.ceil(Math.max(...corners.map((point) => point.y))),
      count: Math.round(candidate.visible * candidate.width * candidate.height),
      cluster: component.cluster,
      fill: candidate.visible,
      ringContrast: component.ringContrast,
      complete: false,
      corners,
      overlapScore: candidate.score,
      geometryEvidence: "occlusion-edges",
    };
  });
}

function robustSizePrior(components: ColorComponent[], maskWidth: number, maskHeight: number) {
  const imageShortSide = Math.min(maskWidth, maskHeight);
  const candidates = components.filter((component) => {
    const width = componentWidth(component);
    const height = componentHeight(component);
    const fill = component.fill ?? component.count / Math.max(1, width * height);
    const touchesBorder = component.minX <= 1 || component.minY <= 1
      || component.maxX >= maskWidth - 2 || component.maxY >= maskHeight - 2;
    return !touchesBorder
      && (component.complete === true || fill >= 0.62)
      && fill >= 0.58
      && Math.min(width, height) >= imageShortSide * 0.075
      && Math.max(width, height) <= imageShortSide * 0.42
      && Math.max(width, height) / Math.max(1, Math.min(width, height)) <= 1.72;
  });
  const initial = candidates.length >= 3 ? candidates : components.filter((component) => {
    const fill = component.fill ?? component.count / Math.max(1, componentWidth(component) * componentHeight(component));
    return fill >= 0.55;
  });
  const fallback = initial.length ? initial : components;
  const medianArea = median(fallback.map((component) => component.count));
  const training = fallback.filter((component) => component.count >= medianArea * 0.5 && component.count <= medianArea * 1.65);
  const finalTraining = training.length >= 3 ? training : fallback;
  const visiblePixels = Math.max(24, median(finalTraining.map((component) => component.count)));
  const paperArea = visiblePixels / 0.84;
  const aspect = clamp(median(finalTraining.map((component) => {
    const width = componentWidth(component);
    const height = componentHeight(component);
    return Math.max(width, height) / Math.max(1, Math.min(width, height));
  })), 1, 1.38);
  const shortSide = Math.max(8, Math.sqrt(paperArea / aspect));
  return {
    baseShortSide: shortSide,
    baseLongSide: shortSide * aspect,
    typicalVisiblePixels: visiblePixels,
  };
}

function geometryQuad(component: NoteGeometry) {
  return component.corners ?? boxCorners(component);
}

function geometryAngle(component: NoteGeometry) {
  const quad = geometryQuad(component);
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
}

function suppressDuplicateGeometries(components: NoteGeometry[], baseShortSide: number) {
  const ranked = [...components].sort((left, right) => {
    const leftScore = left.overlapScore ?? (left.complete ? 0.76 : 0.5);
    const rightScore = right.overlapScore ?? (right.complete ? 0.76 : 0.5);
    return rightScore - leftScore || right.count - left.count;
  });
  const kept: NoteGeometry[] = [];
  for (const candidate of ranked) {
    const candidateQuad = geometryQuad(candidate);
    const candidateCenter = candidateQuad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
    const duplicate = kept.some((other) => {
      const otherQuad = geometryQuad(other);
      const otherCenter = otherQuad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
      const intersection = quadIoU(candidateQuad, otherQuad);
      const centerDistance = Math.hypot(candidateCenter.x - otherCenter.x, candidateCenter.y - otherCenter.y);
      return intersection >= 0.78
        && centerDistance <= baseShortSide * 0.16
        && angleDifference(geometryAngle(candidate), geometryAngle(other)) <= 10 * Math.PI / 180;
    });
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

/**
 * Recovers partly hidden sticky notes from their visible colour islands. A proposal
 * must be supported by two adjacent physical sides; colour area alone is never
 * enough. That intentionally prefers a missed/flagged note over a giant false
 * rectangle that combines several overlapping papers.
 */
export function splitOverlappingComponents(
  components: ColorComponent[],
  labels: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  edgeStrength?: Float32Array,
): NoteGeometry[] {
  if (!components.length || labels.length < maskWidth * maskHeight) return [];
  const { baseShortSide, baseLongSide, typicalVisiblePixels } = robustSizePrior(components, maskWidth, maskHeight);
  const output: NoteGeometry[] = [];

  for (const component of components) {
    const width = componentWidth(component);
    const height = componentHeight(component);
    const fill = component.fill ?? component.count / Math.max(1, width * height);
    const touchesBorder = component.minX <= 1 || component.minY <= 1
      || component.maxX >= maskWidth - 2 || component.maxY >= maskHeight - 2;
    const tooSmall = Math.min(width, height) < baseShortSide * (touchesBorder ? 0.3 : 0.4)
      || component.count < typicalVisiblePixels * (touchesBorder ? 0.09 : 0.14);
    if (tooSmall) continue;

    const typicalPaperArea = typicalVisiblePixels / 0.84;
    const plausibleSingle = width <= baseLongSide * 1.62
      && height <= baseLongSide * 1.62
      && component.count <= typicalPaperArea * 1.62;
    const componentMask = extractComponentMask(component, labels, maskWidth, maskHeight);
    // The colour detector explicitly marks high-fill, high-contrast islands as
    // complete. A low-fill occlusion fragment may still have a plausible box;
    // fitting its visible remainder as a whole paper shrinks and rotates the
    // result toward the occluder. Send those fragments to learned-size edge
    // completion instead. Undefined preserves the pure-geometry test API.
    const sourceComplete = component.complete === true
      || (component.complete === undefined && fill >= 0.58);
    if (plausibleSingle && sourceComplete) {
      const fitted = fitCompleteComponent(
        component,
        componentMask,
        maskWidth,
        maskHeight,
        baseShortSide,
        baseLongSide,
        edgeStrength,
      );
      if (fitted) {
        output.push(fitted);
        continue;
      }
      if (fill >= 0.72) {
        output.push({ ...component, complete: true, geometryEvidence: "complete" });
        continue;
      }
    }

    const recovered = scanOccludedComponent(
      component,
      componentMask,
      maskWidth,
      maskHeight,
      baseShortSide,
      baseLongSide,
      typicalVisiblePixels,
      edgeStrength,
    );
    output.push(...recovered);
  }

  return suppressDuplicateGeometries(output, baseShortSide)
    .sort((left, right) => left.minY - right.minY || left.minX - right.minX)
    .slice(0, 42);
}

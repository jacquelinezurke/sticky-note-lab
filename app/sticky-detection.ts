import { splitOverlappingComponents, type ColorComponent, type NoteGeometry } from "./overlap-geometry.ts";

type LabColor = [number, number, number];

export type StickyGeometryDetection = {
  notes: NoteGeometry[];
  components: ColorComponent[];
  labels: Uint8Array;
  centroids: LabColor[];
  sampleWidth: number;
  sampleHeight: number;
  step: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], position: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round(clamp(position, 0, 1) * (sorted.length - 1))];
}

function rgbToLab([red, green, blue]: [number, number, number]): LabColor {
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

function labDistanceSquared(left: LabColor, right: LabColor) {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

export function clusterPixelsInLab(
  pixelAt: (x: number, y: number) => [number, number, number],
  sampleWidth: number,
  sampleHeight: number,
  requestedClusters = 10,
) {
  const pixelCount = sampleWidth * sampleHeight;
  const labs = new Float32Array(pixelCount * 3);
  for (let index = 0; index < pixelCount; index += 1) {
    const lab = rgbToLab(pixelAt(index % sampleWidth, Math.floor(index / sampleWidth)));
    labs[index * 3] = lab[0];
    labs[index * 3 + 1] = lab[1];
    labs[index * 3 + 2] = lab[2];
  }

  const trainingCount = Math.min(25_000, pixelCount);
  const training = new Int32Array(trainingCount);
  const mean: LabColor = [0, 0, 0];
  for (let index = 0; index < trainingCount; index += 1) {
    const sourceIndex = Math.min(pixelCount - 1, Math.floor((index * pixelCount) / trainingCount));
    training[index] = sourceIndex;
    mean[0] += labs[sourceIndex * 3];
    mean[1] += labs[sourceIndex * 3 + 1];
    mean[2] += labs[sourceIndex * 3 + 2];
  }
  mean[0] /= trainingCount;
  mean[1] /= trainingCount;
  mean[2] /= trainingCount;

  let firstSeed = training[0];
  let firstSeedDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < trainingCount; index += 1) {
    const sourceIndex = training[index];
    const distance = labDistanceSquared(
      [labs[sourceIndex * 3], labs[sourceIndex * 3 + 1], labs[sourceIndex * 3 + 2]],
      mean,
    );
    if (distance < firstSeedDistance) {
      firstSeed = sourceIndex;
      firstSeedDistance = distance;
    }
  }

  const clusterCount = Math.min(requestedClusters, trainingCount);
  const centroids: LabColor[] = [[labs[firstSeed * 3], labs[firstSeed * 3 + 1], labs[firstSeed * 3 + 2]]];
  const nearestSeedDistance = new Float64Array(trainingCount);
  nearestSeedDistance.fill(Number.POSITIVE_INFINITY);
  while (centroids.length < clusterCount) {
    const latest = centroids[centroids.length - 1];
    let nextSeed = training[0];
    let farthestDistance = -1;
    for (let index = 0; index < trainingCount; index += 1) {
      const sourceIndex = training[index];
      const distance = labDistanceSquared(
        [labs[sourceIndex * 3], labs[sourceIndex * 3 + 1], labs[sourceIndex * 3 + 2]],
        latest,
      );
      nearestSeedDistance[index] = Math.min(nearestSeedDistance[index], distance);
      if (nearestSeedDistance[index] > farthestDistance) {
        farthestDistance = nearestSeedDistance[index];
        nextSeed = sourceIndex;
      }
    }
    centroids.push([labs[nextSeed * 3], labs[nextSeed * 3 + 1], labs[nextSeed * 3 + 2]]);
  }

  for (let iteration = 0; iteration < 14; iteration += 1) {
    const sums = new Float64Array(clusterCount * 3);
    const counts = new Uint32Array(clusterCount);
    for (let index = 0; index < trainingCount; index += 1) {
      const sourceIndex = training[index];
      const lab: LabColor = [labs[sourceIndex * 3], labs[sourceIndex * 3 + 1], labs[sourceIndex * 3 + 2]];
      let bestCluster = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const distance = labDistanceSquared(lab, centroids[cluster]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = cluster;
        }
      }
      counts[bestCluster] += 1;
      sums[bestCluster * 3] += lab[0];
      sums[bestCluster * 3 + 1] += lab[1];
      sums[bestCluster * 3 + 2] += lab[2];
    }
    let totalShift = 0;
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if (!counts[cluster]) continue;
      const next: LabColor = [
        sums[cluster * 3] / counts[cluster],
        sums[cluster * 3 + 1] / counts[cluster],
        sums[cluster * 3 + 2] / counts[cluster],
      ];
      totalShift += labDistanceSquared(centroids[cluster], next);
      centroids[cluster] = next;
    }
    if (totalShift < 0.04) break;
  }

  const labels = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const lab: LabColor = [labs[index * 3], labs[index * 3 + 1], labs[index * 3 + 2]];
    let bestCluster = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      const distance = labDistanceSquared(lab, centroids[cluster]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCluster = cluster;
      }
    }
    labels[index] = bestCluster;
  }
  return { labels, centroids };
}

export function majorityFilterLabels(labels: Uint8Array, width: number, height: number, clusterCount: number) {
  const filtered = new Uint8Array(labels.length);
  const votes = new Uint8Array(clusterCount);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      votes.fill(0);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborY < 0 || neighborX >= width || neighborY >= height) continue;
          votes[labels[neighborY * width + neighborX]] += 1;
        }
      }
      const original = labels[y * width + x];
      let winner = original;
      let winnerVotes = votes[original];
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        if (votes[cluster] > winnerVotes) {
          winner = cluster;
          winnerVotes = votes[cluster];
        }
      }
      filtered[y * width + x] = winnerVotes >= 5 ? winner : original;
    }
  }
  return filtered;
}

function componentRingContrast(component: ColorComponent, labels: Uint8Array, centroids: LabColor[], width: number, height: number) {
  const distances: number[] = [];
  const collect = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const outsideCluster = labels[y * width + x];
    if (outsideCluster === component.cluster) return;
    distances.push(Math.sqrt(labDistanceSquared(centroids[component.cluster], centroids[outsideCluster])));
  };
  for (let x = component.minX - 2; x <= component.maxX + 2; x += 1) {
    collect(x, component.minY - 2);
    collect(x, component.maxY + 2);
  }
  for (let y = component.minY; y <= component.maxY; y += 1) {
    collect(component.minX - 2, y);
    collect(component.maxX + 2, y);
  }
  return percentile(distances, 0.5);
}

export function findStickyComponents(labels: Uint8Array, centroids: LabColor[], width: number, height: number) {
  const pixelCount = width * height;
  const clusterCounts = new Uint32Array(centroids.length);
  const borderCounts = new Uint32Array(centroids.length);
  let borderPixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cluster = labels[y * width + x];
      clusterCounts[cluster] += 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        borderCounts[cluster] += 1;
        borderPixelCount += 1;
      }
    }
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const candidates: ColorComponent[] = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start]) continue;
    const cluster = labels[start];
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborY < 0 || neighborX >= width || neighborY >= height) continue;
          const neighbor = neighborY * width + neighborX;
          if (visited[neighbor] || labels[neighbor] !== cluster) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    const areaRatio = boxArea / pixelCount;
    const fill = tail / boxArea;
    const aspect = boxWidth / boxHeight;
    const centroid = centroids[cluster];
    const chroma = Math.hypot(centroid[1], centroid[2]);
    const globalShare = clusterCounts[cluster] / pixelCount;
    const borderShare = borderCounts[cluster] / Math.max(1, borderPixelCount);
    const backgroundLike = chroma < 6.5 && (globalShare > 0.025 || borderShare > 0.06);
    const component: ColorComponent = { minX, maxX, minY, maxY, count: tail, cluster, fill };
    const ringContrast = componentRingContrast(component, labels, centroids, width, height);
    const completeRectangle = areaRatio >= 0.006 && areaRatio <= 0.19
      && aspect >= 0.34 && aspect <= 2.3 && fill >= 0.55 && ringContrast >= 4.5;
    const occludedRectangle = areaRatio >= 0.003 && areaRatio <= 0.19
      && aspect >= 0.34 && aspect <= 2.3 && fill >= 0.34 && ringContrast >= 14;
    // Several touching same-colour papers can form one large island. Do not
    // discard it before the occlusion-aware splitter gets a chance to recover
    // the individual rectangles.
    const mergedRectangle = areaRatio >= 0.012 && areaRatio <= 0.32
      && aspect >= 0.22 && aspect <= 4 && fill >= 0.2 && ringContrast >= 12;
    if (!backgroundLike && centroid[0] >= 45 && chroma >= 5.5
      && (completeRectangle || occludedRectangle || mergedRectangle)) {
      candidates.push({ ...component, ringContrast, complete: completeRectangle });
    }
  }
  // Connected components are disjoint by construction. Axis-aligned bounding
  // boxes can nevertheless overlap almost completely for two genuinely
  // different, rotated papers, so pre-split AABB suppression loses real notes.
  // Polygon-aware duplicate fusion happens after geometry recovery instead.
  return candidates.sort((left, right) => right.count - left.count);
}

function createRgbEdgeStrength(
  pixelAt: (x: number, y: number) => [number, number, number],
  width: number,
  height: number,
) {
  const rgb = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    rgb.set(pixelAt(index % width, Math.floor(index / width)), index * 3);
  }
  const edges = new Float32Array(width * height);
  const sample = (x: number, y: number, channel: number) => rgb[(y * width + x) * 3 + channel];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let magnitudeSquared = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const gradientX = sample(x + 1, y - 1, channel) + sample(x + 1, y, channel) * 2 + sample(x + 1, y + 1, channel)
          - sample(x - 1, y - 1, channel) - sample(x - 1, y, channel) * 2 - sample(x - 1, y + 1, channel);
        const gradientY = sample(x - 1, y + 1, channel) + sample(x, y + 1, channel) * 2 + sample(x + 1, y + 1, channel)
          - sample(x - 1, y - 1, channel) - sample(x, y - 1, channel) * 2 - sample(x + 1, y - 1, channel);
        magnitudeSquared += gradientX * gradientX + gradientY * gradientY;
      }
      edges[y * width + x] = clamp(Math.sqrt(magnitudeSquared) / 720, 0, 1);
    }
  }
  return edges;
}

/** Browser- and Node-compatible production geometry pipeline. */
export function detectStickyGeometryFromRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  maxSampleSide = 620,
): StickyGeometryDetection {
  const step = Math.max(1, Math.round(Math.max(width, height) / maxSampleSide));
  const sampleWidth = Math.ceil(width / step);
  const sampleHeight = Math.ceil(height / step);
  const pixelAt = (sampleX: number, sampleY: number): [number, number, number] => {
    const x = Math.min(width - 1, sampleX * step);
    const y = Math.min(height - 1, sampleY * step);
    const index = (y * width + x) * 4;
    return [data[index], data[index + 1], data[index + 2]];
  };
  const clustered = clusterPixelsInLab(pixelAt, sampleWidth, sampleHeight, 10);
  const labels = majorityFilterLabels(clustered.labels, sampleWidth, sampleHeight, clustered.centroids.length);
  const edgeStrength = createRgbEdgeStrength(pixelAt, sampleWidth, sampleHeight);
  const components = findStickyComponents(labels, clustered.centroids, sampleWidth, sampleHeight);
  const notes = splitOverlappingComponents(components, labels, sampleWidth, sampleHeight, edgeStrength);
  return {
    notes,
    components,
    labels,
    centroids: clustered.centroids,
    sampleWidth,
    sampleHeight,
    step,
  };
}

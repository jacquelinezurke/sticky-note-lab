import assert from "node:assert/strict";
import test from "node:test";

import {
  splitOverlappingComponents,
  type ColorComponent,
} from "../app/overlap-geometry.ts";

function drawRectangle(
  labels: Uint8Array,
  width: number,
  height: number,
  cluster: number,
  centerX: number,
  centerY: number,
  rectangleWidth: number,
  rectangleHeight: number,
  angleDegrees = 0,
) {
  const angle = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offsetX = x - centerX;
      const offsetY = y - centerY;
      const localX = offsetX * cosine + offsetY * sine;
      const localY = -offsetX * sine + offsetY * cosine;
      if (Math.abs(localX) <= rectangleWidth / 2 && Math.abs(localY) <= rectangleHeight / 2) {
        labels[y * width + x] = cluster;
      }
    }
  }
}

function componentsFor(labels: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(labels.length);
  const queue = new Int32Array(labels.length);
  const components: ColorComponent[] = [];
  for (let start = 0; start < labels.length; start += 1) {
    if (visited[start] || labels[start] === 0) continue;
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
    components.push({ minX, maxX, minY, maxY, count: tail, cluster });
  }
  return components;
}

function center(component: ColorComponent) {
  return {
    x: (component.minX + component.maxX) / 2,
    y: (component.minY + component.maxY) / 2,
  };
}

function hasCenterNear(components: ColorComponent[], expectedX: number, expectedY: number, tolerance = 17) {
  return components.some((component) => {
    const actual = center(component);
    return Math.hypot(actual.x - expectedX, actual.y - expectedY) <= tolerance;
  });
}

test("recovers exactly two rotated notes from one same-colour overlap island", () => {
  const width = 270;
  const height = 190;
  const labels = new Uint8Array(width * height);
  drawRectangle(labels, width, height, 1, 35, 32, 54, 46);
  drawRectangle(labels, width, height, 1, 232, 32, 54, 46);
  drawRectangle(labels, width, height, 1, 35, 157, 54, 46);
  drawRectangle(labels, width, height, 1, 109, 79, 58, 48, -12);
  drawRectangle(labels, width, height, 1, 151, 105, 58, 48, 14);

  const input = componentsFor(labels, width, height);
  assert.equal(input.length, 4, "the two overlapping notes should start as one colour component");
  const result = splitOverlappingComponents(input, labels, width, height);

  assert.equal(result.length, 5, `expected three anchors plus exactly two recovered notes, got ${result.length}`);
  assert.ok(hasCenterNear(result, 109, 79, 8), "first covered note should be recovered within eight pixels");
  assert.ok(hasCenterNear(result, 151, 105, 8), "second covered note should be recovered within eight pixels");
  assert.equal(result.filter((component) => component.geometryEvidence === "occlusion-edges").length, 2,
    "only the two covered notes should require occlusion reconstruction");
});

test("keeps differently coloured overlapping notes as separate objects", () => {
  const width = 250;
  const height = 170;
  const labels = new Uint8Array(width * height);
  drawRectangle(labels, width, height, 1, 30, 28, 50, 44);
  drawRectangle(labels, width, height, 2, 220, 28, 50, 44);
  drawRectangle(labels, width, height, 3, 30, 142, 50, 44);
  drawRectangle(labels, width, height, 1, 105, 84, 58, 50, -9);
  drawRectangle(labels, width, height, 2, 135, 98, 58, 50, 11);

  const input = componentsFor(labels, width, height);
  const result = splitOverlappingComponents(input, labels, width, height);

  assert.ok(hasCenterNear(result, 105, 84));
  assert.ok(hasCenterNear(result, 135, 98));
  assert.ok(result.some((component) => component.cluster === 1));
  assert.ok(result.some((component) => component.cluster === 2));
});

test("does not promote a tiny colour fragment to a sticky note", () => {
  const width = 220;
  const height = 150;
  const labels = new Uint8Array(width * height);
  drawRectangle(labels, width, height, 1, 30, 28, 50, 44);
  drawRectangle(labels, width, height, 2, 190, 28, 50, 44);
  drawRectangle(labels, width, height, 3, 30, 122, 50, 44);
  drawRectangle(labels, width, height, 4, 110, 82, 50, 44);
  drawRectangle(labels, width, height, 5, 170, 112, 12, 9);

  const result = splitOverlappingComponents(componentsFor(labels, width, height), labels, width, height);
  assert.equal(result.some((component) => component.cluster === 5), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { estimateQuadrilateralFromMask, projectPoint, unitSquareToQuad } from "../app/ocr-preprocessing.ts";

test("projective mapping keeps all four crop corners exact", () => {
  const quad = [
    { x: 10, y: 20 }, { x: 90, y: 14 }, { x: 84, y: 88 }, { x: 16, y: 94 },
  ] as const;
  const map = unitSquareToQuad([...quad]);
  const projected = [projectPoint(map, 0, 0), projectPoint(map, 1, 0), projectPoint(map, 1, 1), projectPoint(map, 0, 1)];
  projected.forEach((point, index) => {
    assert.ok(Math.abs(point.x - quad[index].x) < 1e-6);
    assert.ok(Math.abs(point.y - quad[index].y) < 1e-6);
  });
});

test("mask edge fitting recovers a mildly skewed note instead of its axis box", () => {
  const width = 40;
  const height = 32;
  const labels = new Uint8Array(width * height);
  const cluster = 3;
  for (let y = 6; y <= 26; y += 1) {
    const left = Math.round(5 + (y - 6) * 0.12);
    const right = Math.round(32 + (y - 6) * 0.08);
    for (let x = left; x <= right; x += 1) labels[y * width + x] = cluster;
  }
  const quad = estimateQuadrilateralFromMask(labels, width, height, { minX: 5, maxX: 34, minY: 6, maxY: 26, cluster });
  assert.ok(quad[0].x < quad[1].x && quad[3].x < quad[2].x);
  assert.ok(quad[0].y < quad[3].y && quad[1].y < quad[2].y);
  assert.ok(Math.abs(quad[0].x - quad[3].x) >= 1);
});

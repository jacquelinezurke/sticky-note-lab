import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import sharp from "sharp";
import { detectStickyGeometryFromRgba } from "../app/sticky-detection.ts";

test("the production detector stays conservative on a photographed Post-it board", async () => {
  const source = fileURLToPath(new URL("./fixtures/postit-board.jpg", import.meta.url));
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const detection = detectStickyGeometryFromRgba(data, info.width, info.height);

  // This fixture contains 20+ visible papers, including clipped and occluded
  // notes. Exact recall is intentionally not hard-coded, but one colour island
  // must never explode into a crowd of duplicate rectangles again.
  assert.ok(detection.notes.length >= 18, `expected broad recall, got ${detection.notes.length}`);
  assert.ok(
    detection.notes.length <= detection.components.length + 3,
    `${detection.components.length} colour islands produced ${detection.notes.length} rectangles`,
  );

  const centers: Array<{ x: number; y: number; area: number }> = [];
  for (const note of detection.notes) {
    const corners = note.corners ?? [
      { x: note.minX, y: note.minY },
      { x: note.maxX, y: note.minY },
      { x: note.maxX, y: note.maxY },
      { x: note.minX, y: note.maxY },
    ];
    for (const corner of corners) {
      assert.ok(Number.isFinite(corner.x) && Number.isFinite(corner.y));
      assert.ok(corner.x >= 0 && corner.x < info.width);
      assert.ok(corner.y >= 0 && corner.y < info.height);
    }
    const width = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const height = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const area = width * height;
    assert.ok(area < info.width * info.height * 0.095, `implausibly large paper area: ${area}`);
    centers.push({
      x: corners.reduce((sum, corner) => sum + corner.x / 4, 0),
      y: corners.reduce((sum, corner) => sum + corner.y / 4, 0),
      area,
    });
  }

  for (let left = 0; left < centers.length; left += 1) {
    for (let right = left + 1; right < centers.length; right += 1) {
      const distance = Math.hypot(centers[left].x - centers[right].x, centers[left].y - centers[right].y);
      const scale = Math.sqrt(Math.min(centers[left].area, centers[right].area));
      assert.ok(distance > scale * 0.08, `near-identical duplicate centers at ${left}/${right}`);
    }
  }

  assert.ok(
    detection.notes.some((note) => note.geometryEvidence === "occlusion-edges"),
    "the held/occluded paper should use an edge-supported reconstruction",
  );
});

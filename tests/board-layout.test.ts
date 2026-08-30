import assert from "node:assert/strict";
import test from "node:test";

import {
  createTidyLayout,
  inferOverlapLayerOrder,
  quadToBoardGeometry,
  type BoardQuad,
} from "../app/board-layout.ts";

function rotatedQuad(centerX: number, centerY: number, width: number, height: number, angleDegrees: number): BoardQuad {
  const angle = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const point = (x: number, y: number) => ({
    x: centerX + x * cosine - y * sine,
    y: centerY + x * sine + y * cosine,
  });
  return [
    point(-width / 2, -height / 2),
    point(width / 2, -height / 2),
    point(width / 2, height / 2),
    point(-width / 2, height / 2),
  ];
}

function approximate(actual: number, expected: number, tolerance = 0.25) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("recovers true note size and rotation from a source-image quad", () => {
  const geometry = quadToBoardGeometry(rotatedQuad(500, 200, 300, 100, -15), 1000, 500);
  approximate(geometry.x, 35);
  approximate(geometry.y, 30);
  approximate(geometry.width, 30);
  approximate(geometry.height, 20);
  approximate(geometry.rotation, -15);
});

test("creates a deterministic straight grid without overlap and keeps source notes immutable", () => {
  const notes = Array.from({ length: 24 }, (_, index) => ({
    id: `note-${index}`,
    x: (index * 17) % 83,
    y: (index * 29) % 81,
    width: 12 + index % 4,
    height: 14 + index % 3,
    rotation: index % 2 ? -18 : 12,
    zIndex: 30 - index,
    text: `Text ${index}`,
    color: index % 2 ? "pink" : "yellow",
  }));
  const original = structuredClone(notes);
  const first = createTidyLayout(notes, 1.6);
  const second = createTidyLayout(notes, 1.6);

  assert.deepEqual(first, second);
  assert.deepEqual(notes, original);
  assert.deepEqual(new Set(first.map((note) => note.id)), new Set(notes.map((note) => note.id)));
  first.forEach((note) => {
    assert.equal(note.rotation, 0);
    assert.ok(note.x >= 0 && note.y >= 0);
    assert.ok(note.x + note.width <= 100.0001);
    assert.ok(note.y + note.height <= 100.0001);
    assert.equal(note.text, notes.find((source) => source.id === note.id)?.text);
    assert.equal(note.color, notes.find((source) => source.id === note.id)?.color);
  });
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      const a = first[left];
      const b = first[right];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `${a.id} overlaps ${b.id}`);
    }
  }
});

test("infers which differently coloured overlapping note lies on top", () => {
  const width = 100;
  const height = 100;
  const first: BoardQuad = [{ x: 15, y: 15 }, { x: 65, y: 15 }, { x: 65, y: 65 }, { x: 15, y: 65 }];
  const second: BoardQuad = [{ x: 42, y: 35 }, { x: 88, y: 35 }, { x: 88, y: 82 }, { x: 42, y: 82 }];
  const paint = (topCluster: 1 | 2) => {
    const labels = new Uint8Array(width * height);
    const fill = (quad: BoardQuad, cluster: number) => {
      const minX = Math.floor(Math.min(...quad.map((point) => point.x)));
      const maxX = Math.ceil(Math.max(...quad.map((point) => point.x)));
      const minY = Math.floor(Math.min(...quad.map((point) => point.y)));
      const maxY = Math.ceil(Math.max(...quad.map((point) => point.y)));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) labels[y * width + x] = cluster;
    };
    if (topCluster === 2) { fill(first, 1); fill(second, 2); } else { fill(second, 2); fill(first, 1); }
    return labels;
  };
  const proposals = [{ cluster: 1, corners: first }, { cluster: 2, corners: second }];
  const secondOnTop = inferOverlapLayerOrder(proposals, paint(2), width, height);
  const firstOnTop = inferOverlapLayerOrder(proposals, paint(1), width, height);
  assert.ok(secondOnTop[1] > secondOnTop[0]);
  assert.ok(firstOnTop[0] > firstOnTop[1]);
});

test("uses deterministic detection order when same-colour stacking is unknowable", () => {
  const quad = rotatedQuad(50, 50, 40, 40, 0);
  const labels = new Uint8Array(100 * 100);
  const order = inferOverlapLayerOrder([
    { cluster: 1, corners: quad },
    { cluster: 1, corners: rotatedQuad(58, 56, 40, 40, 0) },
  ], labels, 100, 100);
  assert.deepEqual(order, [0, 1]);
});

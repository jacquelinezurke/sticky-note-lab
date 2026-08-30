import assert from "node:assert/strict";
import test from "node:test";

import {
  appendManualSymbol,
  fuseSymbolDetections,
  mergeRecognizedSymbols,
  reconcileRecognizedSymbols,
  recognizeSimpleSymbols,
  type RecognizedSymbol,
  type SimpleSymbol,
} from "../app/symbol-recognition.ts";

const WIDTH = 120;
const HEIGHT = 100;

function disk(mask: Uint8Array, centerX: number, centerY: number, radius = 2) {
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) {
        mask[y * WIDTH + x] = 1;
      }
    }
  }
}

function line(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number, stroke = 4) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.7));
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    disk(mask, x0 + (x1 - x0) * ratio, y0 + (y1 - y0) * ratio, stroke / 2);
  }
}

function ellipse(mask: Uint8Array, centerX: number, centerY: number, radiusX: number, radiusY: number, stroke = 3) {
  let previous: [number, number] | null = null;
  for (let step = 0; step <= 180; step += 1) {
    const angle = (step / 180) * Math.PI * 2;
    const point: [number, number] = [centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY];
    if (previous) line(mask, previous[0], previous[1], point[0], point[1], stroke);
    previous = point;
  }
}

function quadratic(mask: Uint8Array, from: [number, number], control: [number, number], to: [number, number], stroke = 3) {
  let previous = from;
  for (let step = 1; step <= 40; step += 1) {
    const ratio = step / 40;
    const inverse = 1 - ratio;
    const point: [number, number] = [
      inverse ** 2 * from[0] + 2 * inverse * ratio * control[0] + ratio ** 2 * to[0],
      inverse ** 2 * from[1] + 2 * inverse * ratio * control[1] + ratio ** 2 * to[1],
    ];
    line(mask, previous[0], previous[1], point[0], point[1], stroke);
    previous = point;
  }
}

function arrow(direction: "left" | "right" | "up" | "down") {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const rotate = (x: number, y: number): [number, number] => {
    if (direction === "right") return [x, y];
    if (direction === "left") return [WIDTH - x, y];
    if (direction === "down") return [y + 10, x - 10];
    return [y + 10, HEIGHT - x + 10];
  };
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    const first = rotate(x0, y0);
    const second = rotate(x1, y1);
    line(mask, first[0], first[1], second[0], second[1], 4);
  };
  segment(24, 50, 88, 50);
  segment(88, 50, 67, 34);
  segment(88, 50, 67, 66);
  return mask;
}

function heart() {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const points: Array<[number, number]> = [
    [60, 78], [49, 68], [38, 57], [31, 45], [32, 34], [40, 27], [49, 28], [60, 40],
    [71, 28], [80, 27], [88, 35], [88, 46], [82, 57], [71, 68], [60, 78],
  ];
  for (let index = 1; index < points.length; index += 1) line(mask, points[index - 1][0], points[index - 1][1], points[index][0], points[index][1], 4);
  return mask;
}

function brokenHeart() {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const left: Array<[number, number]> = [
    [57, 41], [49, 29], [40, 27], [32, 35], [31, 46], [38, 57], [49, 68], [58, 78],
  ];
  const right: Array<[number, number]> = [
    [63, 41], [71, 29], [80, 27], [88, 35], [89, 46], [82, 57], [71, 68], [62, 78],
  ];
  for (const half of [left, right]) {
    for (let index = 1; index < half.length; index += 1) line(mask, half[index - 1][0], half[index - 1][1], half[index][0], half[index][1], 4);
  }
  return mask;
}

function parallelStrokes() {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  line(mask, 48, 27, 48, 78, 4);
  line(mask, 70, 27, 70, 78, 4);
  return mask;
}

function exclamation() {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  line(mask, 60, 20, 60, 65, 6);
  disk(mask, 60, 80, 4);
  return mask;
}

function face(happy: boolean) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  ellipse(mask, 60, 50, 31, 34, 3);
  disk(mask, 49, 41, 3);
  disk(mask, 71, 40, 3);
  if (happy) quadratic(mask, [44, 59], [60, 76], [77, 58], 3);
  else quadratic(mask, [44, 70], [60, 53], [77, 70], 3);
  return mask;
}

function recognized(mask: Uint8Array) {
  return recognizeSimpleSymbols(mask, WIDTH, HEIGHT).map((entry) => entry.symbol);
}

function rotated(mask: Uint8Array, degrees: number) {
  const output = new Uint8Array(mask.length);
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (WIDTH - 1) / 2;
  const centerY = (HEIGHT - 1) / 2;
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    if (!mask[y * WIDTH + x]) continue;
    const targetX = Math.round(centerX + (x - centerX) * cosine - (y - centerY) * sine);
    const targetY = Math.round(centerY + (x - centerX) * sine + (y - centerY) * cosine);
    if (targetX >= 0 && targetX < WIDTH && targetY >= 0 && targetY < HEIGHT) disk(output, targetX, targetY, 1);
  }
  return output;
}

test("recognizes all four handwritten arrow directions", () => {
  assert.deepEqual(recognized(arrow("left")), ["←"]);
  assert.deepEqual(recognized(arrow("right")), ["→"]);
  assert.deepEqual(recognized(arrow("up")), ["↑"]);
  assert.deepEqual(recognized(arrow("down")), ["↓"]);
});

test("recognizes a heart and an isolated exclamation mark", () => {
  assert.deepEqual(recognized(heart()), ["♥"]);
  assert.deepEqual(recognized(brokenHeart()), ["♥"]);
  assert.deepEqual(recognized(exclamation()), ["!"]);
});

test("does not confuse two handwritten one-strokes with a broken heart", () => {
  assert.deepEqual(recognized(parallelStrokes()), []);
});

test("uses mouth curvature to distinguish happy and sad faces", () => {
  assert.deepEqual(recognized(face(true)), ["☺"]);
  assert.deepEqual(recognized(face(false)), ["☹"]);
});

test("keeps direction and mood under mild hand-drawn tilt", () => {
  assert.deepEqual(recognized(rotated(arrow("right"), 7)), ["→"]);
  assert.deepEqual(recognized(rotated(arrow("up"), -7)), ["↑"]);
  assert.deepEqual(recognized(rotated(heart(), 6)), ["♥"]);
  assert.deepEqual(recognized(rotated(face(true), -6)), ["☺"]);
  assert.deepEqual(recognized(rotated(face(false), 4)), ["☹"]);
});

test("rejects text-like H, I, T, V and O shapes", () => {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  line(mask, 12, 30, 12, 70, 4); line(mask, 30, 30, 30, 70, 4); line(mask, 12, 50, 30, 50, 4);
  line(mask, 44, 30, 44, 70, 4);
  line(mask, 54, 30, 78, 30, 4); line(mask, 66, 30, 66, 70, 4);
  line(mask, 81, 30, 91, 70, 4); line(mask, 101, 30, 91, 70, 4);
  ellipse(mask, 109, 50, 7, 20, 3);
  assert.deepEqual(recognized(mask), []);
});

test("does not turn isolated K, Y, T, V, O or I glyphs into symbols", () => {
  const glyphs: Array<() => Uint8Array> = [
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      line(mask, 45, 25, 45, 76, 5); line(mask, 45, 50, 74, 24, 5); line(mask, 45, 50, 75, 77, 5);
      return mask;
    },
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      line(mask, 38, 24, 60, 50, 5); line(mask, 82, 24, 60, 50, 5); line(mask, 60, 50, 60, 78, 5);
      return mask;
    },
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      line(mask, 37, 26, 83, 26, 5); line(mask, 60, 26, 60, 78, 5);
      return mask;
    },
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      line(mask, 38, 25, 60, 78, 5); line(mask, 82, 25, 60, 78, 5);
      return mask;
    },
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      ellipse(mask, 60, 50, 26, 32, 4);
      return mask;
    },
    () => {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      line(mask, 60, 24, 60, 78, 6);
      return mask;
    },
  ];
  const names = ["K", "Y", "T", "V", "O", "I"];
  glyphs.forEach((makeMask, index) => assert.deepEqual(recognized(makeMask()), [], names[index]));
});

test("requires the face ring, two eyes and a curved mouth", () => {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  ellipse(mask, 60, 50, 31, 34, 3);
  disk(mask, 49, 41, 3);
  quadratic(mask, [44, 59], [60, 76], [77, 58], 3);
  assert.deepEqual(recognized(mask), []);
});

test("fuses only matching symbol evidence from both preprocessing masks", () => {
  const detection = (symbol: SimpleSymbol, x: number): RecognizedSymbol => ({
    symbol,
    label: symbol,
    confidence: 88,
    x,
    y: 0.2,
    width: 0.24,
    height: 0.3,
  });
  assert.deepEqual(fuseSymbolDetections([detection("♥", 0.2)], [detection("→", 0.2)]), []);
  const fused = fuseSymbolDetections([detection("♥", 0.2)], [detection("♥", 0.21)]);
  assert.equal(fused[0]?.symbol, "♥");
  assert.ok((fused[0]?.confidence ?? 0) >= 82);
});

test("appends recognized glyphs once and keeps them editable plain text", () => {
  const detections: RecognizedSymbol[] = [
    { symbol: "→", label: "Pfeil", confidence: 90, x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
    { symbol: "♥", label: "Herz", confidence: 91, x: 0.5, y: 0.2, width: 0.2, height: 0.2 },
  ];
  assert.equal(mergeRecognizedSymbols("PLAN", detections), "PLAN\n→ ♥");
  assert.equal(mergeRecognizedSymbols("PLAN\n→", detections), "PLAN\n→\n♥");
  assert.equal(mergeRecognizedSymbols("", detections), "→ ♥");
  assert.equal(appendManualSymbol("PLAN", "→"), "PLAN →");
  assert.equal(appendManualSymbol("PLAN →", "→"), "PLAN → →");
});

test("replaces a dominant heart's OCR-only 11 confusion without deleting real numbers", () => {
  const heartDetection: RecognizedSymbol = {
    symbol: "♥",
    label: "Herz",
    confidence: 93,
    dominantInk: 0.92,
    x: 0.2,
    y: 0.2,
    width: 0.5,
    height: 0.5,
  };
  assert.equal(reconcileRecognizedSymbols("11", [heartDetection]), "♥");
  assert.equal(reconcileRecognizedSymbols("1\n1", [heartDetection]), "♥");
  assert.equal(reconcileRecognizedSymbols("PLAN 11", [heartDetection]), "PLAN 11\n♥");
  assert.equal(reconcileRecognizedSymbols("2026", [heartDetection]), "2026\n♥");
  assert.equal(reconcileRecognizedSymbols("11", [{ ...heartDetection, confidence: 82 }]), "11\n♥");
  assert.equal(reconcileRecognizedSymbols("11", [{ ...heartDetection, dominantInk: 0.42 }]), "11\n♥");
  assert.equal(reconcileRecognizedSymbols("11", [{ ...heartDetection, symbol: "→", label: "Pfeil" }]), "11\n→");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateNoteLab,
  nearestStickyPalette,
  rgbToLab,
  type ColorQuad,
  type RgbColor,
} from "../app/note-color.ts";

const PALETTE = {
  yellow: "#f7dc68",
  pink: "#f2a3b4",
  blue: "#a9d9ee",
  green: "#b9dfa5",
  purple: "#cdb8ee",
  orange: "#f2b46d",
};

function raster(width: number, height: number, fill: RgbColor) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = fill[0];
    data[index * 4 + 1] = fill[1];
    data[index * 4 + 2] = fill[2];
    data[index * 4 + 3] = 255;
  }
  return data;
}

function paint(data: Uint8ClampedArray, width: number, left: number, top: number, right: number, bottom: number, color: RgbColor) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
    }
  }
}

const FULL_QUAD: ColorQuad = [
  { x: 0, y: 0 },
  { x: 119, y: 0 },
  { x: 119, y: 119 },
  { x: 0, y: 119 },
];

test("keeps a yellow note yellow despite dense black handwriting and a dark edge shadow", () => {
  const paper: RgbColor = [236, 207, 74];
  const data = raster(120, 120, paper);
  paint(data, 120, 0, 0, 120, 9, [72, 63, 41]);
  for (let y = 25; y < 93; y += 14) paint(data, 120, 18, y, 101, y + 5, [31, 31, 27]);
  const lab = estimateNoteLab(data, 120, 120, FULL_QUAD, rgbToLab(paper));
  assert.equal(nearestStickyPalette(lab), PALETTE.yellow);
});

test("uses the detector seed to reject a differently coloured overlap covering most of a blue note", () => {
  const blue: RgbColor = [124, 199, 224];
  const data = raster(120, 120, blue);
  paint(data, 120, 30, 0, 120, 120, [235, 145, 165]);
  paint(data, 120, 3, 20, 24, 92, [25, 25, 24]);
  const lab = estimateNoteLab(data, 120, 120, FULL_QUAD, rgbToLab(blue));
  assert.equal(nearestStickyPalette(lab), PALETTE.blue);
});

test("classifies coloured paper consistently under darker and brighter exposure", () => {
  const cases: Array<[RgbColor, string]> = [
    [[178, 153, 51], PALETTE.yellow],
    [[255, 191, 205], PALETTE.pink],
    [[116, 183, 211], PALETTE.blue],
    [[143, 193, 120], PALETTE.green],
    [[177, 148, 213], PALETTE.purple],
    [[220, 142, 64], PALETTE.orange],
  ];
  for (const [rgb, expected] of cases) assert.equal(nearestStickyPalette(rgbToLab(rgb)), expected);
});

test("does not turn a pale but chromatic sticky into white or gray", () => {
  assert.equal(nearestStickyPalette(rgbToLab([250, 238, 166])), PALETTE.yellow);
  assert.equal(nearestStickyPalette(rgbToLab([210, 232, 240])), PALETTE.blue);
});

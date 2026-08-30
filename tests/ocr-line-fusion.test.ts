import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import nspell from "nspell";
import { fuseOcrLines, type FusionCandidate, type FusionContext } from "../app/ocr-fusion.ts";

const de = nspell(fs.readFileSync("./public/dictionaries/de.aff", "utf8"), fs.readFileSync("./public/dictionaries/de.dic", "utf8"));
const en = nspell(fs.readFileSync("./public/dictionaries/en.aff", "utf8"), fs.readFileSync("./public/dictionaries/en.dic", "utf8"));
const protectedTerms = new Set(["kanban", "figma", "ppt", "zentaro"]);
const lexicon = {
  isKnown: (word: string) => {
    const lower = word.toLocaleLowerCase("de-DE");
    return protectedTerms.has(lower) || de.correct(word) || en.correct(word) || de.correct(lower) || en.correct(lower);
  },
};

function fuse(candidates: FusionCandidate[]) {
  return fuseOcrLines(candidates, lexicon)?.text ?? "";
}

function fuseResult(candidates: FusionCandidate[], context: FusionContext = {}) {
  const result = fuseOcrLines(candidates, lexicon, context);
  assert.ok(result);
  return result;
}

test("visual consensus beats one confident misspelling", () => {
  assert.equal(fuse([
    { engine: "paddle", variant: "rgb", confidence: 58, text: "REVIEW\nBUDGET" },
    { engine: "paddle", variant: "contrast", confidence: 82, text: "REVEW\nBUDGET" },
    { engine: "dehtr", variant: "gray", confidence: 61, text: "REVIEW\nBUDGET" },
  ]), "REVIEW\nBUDGET");
});

test("cross-engine agreement beats a plausible real-word error", () => {
  assert.equal(fuse([
    { engine: "paddle", variant: "rgb", confidence: 74, text: "ORDER POSTS" },
    { engine: "dehtr", variant: "gray", confidence: 69, text: "ORDER POSTS" },
    { engine: "paddle", variant: "ink", confidence: 91, text: "OLDER POSTS" },
  ]), "ORDER POSTS");
});

test("missing lines stay present when the strongest document contains them", () => {
  assert.equal(fuse([
    { engine: "paddle", variant: "rgb", confidence: 64, text: "CHECK EMAIL\nFIX TEMPLATE" },
    { engine: "paddle", variant: "contrast", confidence: 78, text: "CHECK EMAIL" },
  ]), "CHECK EMAIL\nFIX TEMPLATE");
});

test("unknown project vocabulary is preserved; no semantic replacement is invented", () => {
  const candidates: FusionCandidate[] = [
    { engine: "paddle", variant: "rgb", confidence: 55, text: "PROJECT ZENTARO" },
    { engine: "dehtr", variant: "gray", confidence: 75, text: "PROJECT ZENTARO" },
  ];
  const output = fuse(candidates);
  assert.equal(output, "PROJECT ZENTARO");
  assert.ok(candidates.some((candidate) => candidate.text.split("\n").includes(output)));
});

test("non-text scanner artifacts do not create extra rows", () => {
  assert.equal(fuse([
    { engine: "paddle", variant: "rgb", confidence: 60, text: "CHECK BUDGET\nSEND EMAIL" },
    { engine: "tesseract", variant: "sparse", confidence: 82, text: "?\nCHECK BUDGET\nSEND EMAIL" },
  ]), "CHECK BUDGET\nSEND EMAIL");
});

test("same-engine filter variants count as one reader", () => {
  const result = fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 91, text: "hi" },
    { engine: "paddle", variant: "gray", confidence: 94, text: "hi" },
    { engine: "paddle", variant: "sauvola", confidence: 97, text: "hi" },
    { engine: "paddle", variant: "ink", confidence: 95, text: "hi" },
    { engine: "dehtr", variant: "gray", confidence: 57, text: "CREATIVITY" },
  ], { expectedLineCount: 1, expectedCharacters: 8 });
  assert.equal(result.text, "CREATIVITY");
  assert.equal(result.supportingEngines, 1);
  assert.equal(result.needsReview, true);
});

test("visual completeness beats short screenshot fragments", () => {
  assert.equal(fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 92, text: "I a" },
    { engine: "dehtr", variant: "gray", confidence: 58, text: "TEAM" },
  ], { expectedLineCount: 1, expectedCharacters: 4 }).text, "TEAM");
  assert.equal(fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 90, text: "re\nMc ni" },
    { engine: "dehtr", variant: "gray", confidence: 55, text: "INNOVATION" },
  ], { expectedLineCount: 1, expectedCharacters: 8 }).text, "INNOVATION");
  assert.equal(fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 88, text: "Goss" },
    { engine: "dehtr", variant: "gray", confidence: 59, text: "GOALS" },
  ], { expectedLineCount: 1, expectedCharacters: 5 }).text, "GOALS");
});

test("same-engine repetition cannot fake independent support", () => {
  const result = fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 98, text: "PLAN" },
    { engine: "paddle", variant: "gray", confidence: 99, text: "PLAN" },
    { engine: "paddle", variant: "contrast", confidence: 97, text: "PLAN" },
    { engine: "paddle", variant: "ink", confidence: 99, text: "PLAN" },
  ]);
  assert.equal(result.supportingEngines, 1);
  assert.equal(result.agreement, 0);
});

test("independently confirmed short labels remain valid", () => {
  const result = fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 70, text: "AI" },
    { engine: "dehtr", variant: "gray", confidence: 58, text: "AI" },
  ], { expectedLineCount: 1, expectedCharacters: 2 });
  assert.equal(result.text, "AI");
  assert.equal(result.supportingEngines, 2);
});

test("an unsupported one-character artifact is removed from a complete label", () => {
  const result = fuseResult([
    { engine: "paddle", variant: "rgb", confidence: 90, text: "TEAM" },
    { engine: "dehtr", variant: "gray", confidence: 54, text: "TEAM\nI" },
  ], { expectedLineCount: 2, expectedCharacters: 5 });
  assert.equal(result.text, "TEAM");
});

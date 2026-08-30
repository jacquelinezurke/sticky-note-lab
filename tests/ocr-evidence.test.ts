import assert from "node:assert/strict";
import test from "node:test";

import { mergeOcrEvidence } from "../app/ocr-evidence.ts";
import type { OcrEvidence } from "../app/text-correction.ts";

const note = (text: string, variant: string, confidence = 60): OcrEvidence => ({
  text, confidence, engine: "paddle", variant, scope: "note",
});

test("many high-confidence line crops never evict complete-note evidence", () => {
  let evidence: OcrEvidence[] = [note("FIRST\nSECOND", "rgb", 42)];
  for (let index = 0; index < 12; index += 1) {
    evidence = mergeOcrEvidence(evidence, {
      text: `LINE ${index}`,
      confidence: 99,
      engine: "paddle",
      variant: "line",
      scope: "line",
      lineIndex: index,
    });
  }
  assert.ok(evidence.some((entry) => entry.scope === "note" && entry.text === "FIRST\nSECOND"));
});

test("equivalent same-engine readings collapse to the strongest measured source", () => {
  let evidence = mergeOcrEvidence([], note("ORDER POSTS", "rgb", 44));
  evidence = mergeOcrEvidence(evidence, note("ORDER POSTS", "rgb", 81));
  evidence = mergeOcrEvidence(evidence, note("ORDER POSTS", "contrast", 52));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].confidence, 81);
});

test("many Paddle readings cannot evict an independent DEHTR reading", () => {
  let evidence: OcrEvidence[] = [];
  for (let index = 0; index < 30; index += 1) {
    evidence = mergeOcrEvidence(evidence, note(`PADDLE ${index}`, `filter-${index}`, 60 + index));
  }
  evidence = mergeOcrEvidence(evidence, {
    text: "INDEPENDENT", confidence: 52, engine: "dehtr", variant: "gray", scope: "note",
  });
  assert.ok(evidence.some((entry) => entry.engine === "dehtr" && entry.text === "INDEPENDENT"));
  assert.equal(evidence.filter((entry) => entry.engine === "paddle" && entry.scope === "note").length, 4);
});

test("line evidence stays bounded per line and engine", () => {
  let evidence: OcrEvidence[] = [];
  for (const engine of ["paddle", "dehtr"] as const) {
    for (let index = 0; index < 6; index += 1) {
      evidence = mergeOcrEvidence(evidence, {
        text: `${engine} ${index}`,
        confidence: 40 + index,
        engine,
        variant: `variant-${index}`,
        scope: "line",
        lineIndex: 2,
      });
    }
  }
  assert.equal(evidence.filter((entry) => entry.scope === "line" && entry.lineIndex === 2 && entry.engine === "paddle").length, 2);
  assert.equal(evidence.filter((entry) => entry.scope === "line" && entry.lineIndex === 2 && entry.engine === "dehtr").length, 2);
});

test("a final fused representative survives noisier high-confidence variants", () => {
  let evidence: OcrEvidence[] = [];
  for (let index = 0; index < 10; index += 1) {
    evidence = mergeOcrEvidence(evidence, note(`NOISE ${index}`, `filter-${index}`, 99 - index));
  }
  evidence = mergeOcrEvidence(evidence, note("ESIGN IWRING", "variant-fusion", 61));
  assert.ok(evidence.some((entry) => entry.text === "ESIGN IWRING"));
  assert.equal(evidence.filter((entry) => entry.engine === "paddle" && entry.scope === "note").length, 4);
});

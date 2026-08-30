import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { correctOcrTexts, type OcrEvidence } from "../app/text-correction.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  const relative = `public/${url.replace(/^\//, "")}`;
  const data = fs.readFileSync(relative);
  return new Response(data, { status: 200 });
}) as typeof fetch;

const run = async (text: string, alternatives: OcrEvidence[] = []) => {
  const [result] = await correctOcrTexts([{ id: "note", text, confidence: 74, alternatives }], () => undefined);
  return result;
};

const runOnEnglishBoard = async (
  text: string,
  alternatives: OcrEvidence[] = [],
  engine?: "paddle" | "dehtr" | "tesseract",
) => {
  const results = await correctOcrTexts([
    { id: "context", text: "SOCIAL MEDIA PLAN TEAM CREATIVITY", confidence: 92, alternatives: [] },
    { id: "note", text, confidence: 74, alternatives, engine },
  ], () => undefined);
  return results[1];
};

test("rescues obvious glyph and board terms", async () => {
  assert.equal((await run("B00K KAN8AN")).text, "BOOK KANBAN");
});

test("uses an actually observed lower-confidence reading over gibberish", async () => {
  const result = await run("LEARN\nADOUT\nKANBAN", [
    { text: "LEARN\nABOUT\nKANBAN", confidence: 58, engine: "tesseract", variant: "block", scope: "note" },
    { text: "LEARN\nABOUT\nKANBAN", confidence: 64, engine: "dehtr", variant: "gray", scope: "note" },
    { text: "LEARN\nADOUT\nKANBAN", confidence: 70, engine: "tesseract", variant: "sparse", scope: "note" },
  ]);
  assert.equal(result.text, "LEARN\nABOUT\nKANBAN");
  assert.equal(result.rawText, "LEARN\nADOUT\nKANBAN");
  assert.ok(result.corrections.length > 0);
  assert.ok(result.confidence <= 78);
});

test("does not invent ambiguous ordinary words or alter identifiers", async () => {
  assert.equal((await run("Adout Dreok Repow schadote Q00 2026")).text, "Adout Dreok Repow schadote Q00 2026");
  assert.equal((await run("OLDER POSTS")).text, "OLDER POSTS");
});

test("independent complete-note readings can resolve a real-word OCR error", async () => {
  const result = await run("OLDER POSTS", [
    { text: "ORDER POSTS", confidence: 68, engine: "paddle", variant: "contrast", scope: "note" },
    { text: "ORDER POSTS", confidence: 65, engine: "dehtr", variant: "gray", scope: "note" },
  ]);
  assert.equal(result.text, "ORDER POSTS");
});

test("a line crop can never replace a complete note", async () => {
  const result = await run("FIRST LINE\nSECOND LINE", [
    { text: "SECOND LINE", confidence: 99, engine: "paddle", variant: "line", scope: "line", lineIndex: 1 },
  ]);
  assert.equal(result.text, "FIRST LINE\nSECOND LINE");
});

test("repairs a uniquely recoverable all-caps truncation without guessing ordinary prose", async () => {
  assert.equal((await runOnEnglishBoard("STRATEG")).text, "STRATEGY");
  assert.equal((await runOnEnglishBoard("ESIGN\nIWRING")).text, "DESIGN\nIWRING");
  assert.equal((await runOnEnglishBoard("ICCESS")).text, "ACCESS");
  assert.equal((await runOnEnglishBoard("STRATEG", [
    { text: "STRATEG", confidence: 55, engine: "dehtr", variant: "gray", scope: "note" },
  ], "paddle")).text, "STRATEGY");
});

test("uses a recoverable observed reading over a conflicting real word", async () => {
  const result = await runOnEnglishBoard("RESIGN\nIWRING", [
    { text: "ESIGN\nIWRING", confidence: 72, engine: "paddle", variant: "contrast", scope: "note" },
    { text: "RESIGN\nIWRING", confidence: 54, engine: "dehtr", variant: "gray", scope: "note" },
  ], "dehtr");
  assert.equal(result.text, "DESIGN\nIWRING");
});

test.after(() => { globalThis.fetch = originalFetch; });

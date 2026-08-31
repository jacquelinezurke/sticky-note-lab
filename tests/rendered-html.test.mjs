import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Sticky Note Lab workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Sticky Note Lab/);
  assert.match(html, /Vom Foto zum editierbaren Board/);
  assert.match(html, /Foto hier ablegen/);
  assert.match(html, /Verarbeitung lokal im Browser/);
  assert.match(html, /Board-JSON/);
  assert.match(html, /Board-Anordnung/);
  assert.match(html, /Wie im Foto/);
  assert.match(html, /Sortiert/);
  assert.match(html, /Scanner-Schritte ansehen/);
});

test("ships an interactive explanation of the complete local scanner pipeline", async () => {
  const [page, visualization, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pipeline-visualization.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<PipelineVisualization/);
  assert.match(visualization, /Lab-Raum gruppieren/);
  assert.match(visualization, /Perspektive entzerren/);
  assert.match(visualization, /Sechs Bildvarianten/);
  assert.match(visualization, /PaddleOCR/);
  assert.match(visualization, /DE·HTR/);
  assert.match(visualization, /Tesseract/);
  assert.match(visualization, /EVIDENCE[\s\S]*FUSION/i);
  assert.match(visualization, /OCR-Labor/);
  assert.match(visualization, /Konsens-Labor/);
  assert.match(visualization, /pipeline-vote-metrics/);
  assert.match(visualization, /candidate\.simulated \? "SIMULATION"/);
  assert.match(visualization, /Editierbares Board/);
  assert.match(page, /note\.ocrEvidence\s*=\s*result\?\.alternatives/);
  assert.match(page, /key === "ocrEvidence" \? undefined/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.pipeline-dialog/);
});

test("exports the renamed board format while preserving legacy imports", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /BOARD_EXPORT_FORMAT\s*=\s*"sticky-note-lab-board"/);
  assert.match(page, /LEGACY_BOARD_EXPORT_FORMAT\s*=\s*"postit-lab-board"/);
  assert.match(page, /sticky-note-lab-board\.json/);
  assert.match(page, /sticky-note-lab-board\.png/);
});

test("keeps detected geometry in the photo coordinate system", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /MIN_NOTE_SIZE/);
  assert.match(page, /setBoardAspectRatio\(detected\.aspectRatio\)/);
  assert.match(page, /aspectRatio:\s*boardAspectRatio/);
  assert.match(page, /quadToBoardGeometry\(sourceQuad,\s*width,\s*height\)/);
  assert.match(page, /inferOverlapLayerOrder/);
  assert.match(page, /createTidyLayout\(notes,\s*boardAspectRatio\)/);
  assert.match(page, /transform:\s*`rotate\(\$\{note\.rotation/);
  assert.match(css, /\.board-photo[^}]*object-fit:\s*fill/s);
  assert.match(css, /\.sticky-note\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
  assert.doesNotMatch(css, /\.sticky-note\.detected-note[^}]*transform:\s*none;/s);
});

test("detects pale and overlapping notes without recycling stale scan state", async () => {
  const [page, detector, overlapGeometry] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/sticky-detection.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/overlap-geometry.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /detectStickyGeometryFromRgba/);
  assert.match(detector, /function rgbToLab/);
  assert.match(detector, /clusterPixelsInLab\(pixelAt,\s*sampleWidth,\s*sampleHeight,\s*10\)/);
  assert.match(detector, /majorityFilterLabels/);
  assert.match(detector, /centroid\[0\]\s*>=\s*45/);
  assert.match(detector, /areaRatio\s*>=\s*0\.006/);
  assert.match(detector, /mergedRectangle/);
  assert.match(detector, /return candidates\.sort/);
  assert.match(overlapGeometry, /extractComponentMask/);
  assert.match(overlapGeometry, /strongSides\s*>=\s*3/);
  assert.match(overlapGeometry, /suppressDuplicateGeometries/);
  assert.match(page, /onGeometry\?\.\(geometry\)/);
  assert.match(page, /setNotes\(\[\]\);/);
  assert.match(page, /scanGenerationRef\.current\s*!==\s*scanId/);
  assert.match(page, /disabled=\{isAnalyzing\}/);
});

test("runs perspective-corrected multi-pass handwriting OCR from original pixels", async () => {
  const [page, engine, preprocessing, correction, dehtr] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ocr-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ocr-preprocessing.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/text-correction.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/dehtr-engine.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /estimateQuadrilateralFromMask\(labels,\s*sampleWidth,\s*sampleHeight,\s*component\)/);
  assert.match(page, /recognizeNoteTexts\(image,\s*detected\.map/);
  assert.doesNotMatch(page, /naturalCanvas/);
  assert.doesNotMatch(`${page}\n${engine}`, /Text ergänzen/);
  assert.match(page, /placeholder="Text eingeben …"/);
  assert.match(engine, /PaddleOCR\.create/);
  assert.match(engine, /lang:\s*"de"/);
  assert.match(engine, /ocrVersion:\s*"PP-OCRv6"/);
  assert.match(engine, /worker:\s*import\.meta\.env\.PROD/);
  assert.match(engine, /initialize:\s*false/);
  assert.match(engine, /textDetectionModelName:\s*"PP-OCRv6_small_det"/);
  assert.match(engine, /textRecognitionModelName:\s*"PP-OCRv6_medium_rec"/);
  assert.match(engine, /textDetectionModelAsset:\s*\{\s*url:\s*"\/ocr-models\/PP-OCRv6_small_det_onnx_infer\.tar"/);
  assert.match(engine, /textRecognitionModelAsset:\s*\{\s*url:\s*"\/ocr-models\/PP-OCRv6_medium_rec_onnx_infer\.tar"/);
  assert.match(engine, /wasmPaths:\s*"\/onnx-paddle-1\.24\.3\/"/);
  assert.match(engine, /backend:\s*"wasm"/);
  assert.match(engine, /PADDLE_INIT_TIMEOUT_MS\s*=\s*120_000/);
  assert.match(engine, /transportClient\?\.dispose\(\)/);
  assert.match(engine, /prepareNoteCrops\(image,\s*note\)/);
  assert.match(preprocessing, /unitSquareToQuad/);
  assert.match(preprocessing, /estimateDeskewAngle/);
  assert.match(preprocessing, /sauvola:/);
  assert.match(preprocessing, /ink:/);
  assert.match(preprocessing, /detectTextLineBands/);
  assert.match(engine, /textDetLimitSideLen:\s*1280/);
  assert.match(engine, /PSM\.SINGLE_BLOCK/);
  assert.match(engine, /PSM\.SPARSE_TEXT/);
  assert.match(engine, /recognizeWithDehtr/);
  assert.match(dehtr, /import dehtrWorkerUrl from "\.\/dehtr\.worker\.ts\?worker&url"/);
  assert.match(dehtr, /new Worker\(new URL\(dehtrWorkerUrl,\s*window\.location\.origin\)/);
  assert.match(engine, /stability/);
  assert.match(engine, /fuseOcrLines/);
  assert.match(engine, /getOcrWordChecker/);
  assert.match(engine, /textDetBoxThresh:\s*0\.48/);
  assert.match(engine, /textDetUnclipRatio:\s*2/);
  assert.match(engine, /correctOcrTexts\(rawResults/);
  assert.match(correction, /\/dictionaries\/de\.aff/);
  assert.match(correction, /\/dictionaries\/en\.dic/);
  assert.match(correction, /rawText/);
  assert.doesNotMatch(correction, /ocrConfidence\s*>=/);
  assert.doesNotMatch(correction, /isAllCaps\(word\)\s*&&\s*word\.length\s*<=\s*6/);
  assert.match(correction, /const domainSuggestions/);
  assert.match(engine, /const evidenceById/);
  assert.match(engine, /mergeOcrEvidence/);
  assert.match(engine, /Kauderwelsch wird mit OCR-Lesarten und Wörterbüchern gerettet/);
  assert.match(correction, /weightedOcrDistance/);
  assert.match(correction, /chooseObservedText/);
  assert.match(correction, /hasConfusableDigits/);
  assert.doesNotMatch(correction, /HIGH_CONFIDENCE_RESCUES|COMMON_BIGRAMS/);
});

test("shows honest OCR activity while model progress is indeterminate", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Aktiv seit \{formatElapsed\(analysisElapsed\)\}/);
  assert.match(page, /Erster KI-Start/);
  assert.match(page, /Schritt \{analysisStep\}\/5/);
  assert.match(page, /OCR-Original wiederherstellen/);
  assert.match(page, /data-engine-status=\{diagnostic\.status\}/);
  assert.match(page, /Texterkennung eingeschränkt/);
});

test("recognizes simple symbols outside word OCR and keeps them editable", async () => {
  const [page, engine, symbols, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ocr-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/symbol-recognition.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(symbols, /SIMPLE_SYMBOLS\s*=\s*\["♥",\s*"↑",\s*"↓",\s*"←",\s*"→",\s*"!",\s*"☺",\s*"☹"\]/);
  assert.match(symbols, /recognizeSimpleSymbolsFromCanvases/);
  assert.match(symbols, /fuseSymbolDetections/);
  assert.match(engine, /results\s*=\s*results\.map/);
  assert.match(engine, /reconcileRecognizedSymbols\(result\.text,\s*symbols\)/);
  assert.ok(engine.indexOf("correctOcrTexts(rawResults") < engine.indexOf("reconcileRecognizedSymbols(result.text"));
  assert.match(symbols, /heartConfusion/);
  assert.match(symbols, /dominantInk/);
  assert.match(page, /aria-label="Symbol einfügen"/);
  assert.match(page, /appendManualSymbol\(note\.text,\s*symbol\)/);
  assert.match(css, /\.symbol-picker/);
  assert.doesNotMatch(engine, /recordEvidence\([^\n]*symbol/iu);
});

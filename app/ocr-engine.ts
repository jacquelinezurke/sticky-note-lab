"use client";

import { recognizeHandwrittenLine } from "./dehtr-engine";
import { assessOcrText, fuseOcrLines as fuseCompleteOcrLines, ocrTextSimilarity, type FusionContext } from "./ocr-fusion";
import { mergeOcrEvidence } from "./ocr-evidence";
import {
  createTextLineCrop,
  detectTextLineBands,
  disposePreparedNoteCrops,
  prepareNoteCrops,
  type OcrRegion as NoteRegion,
} from "./ocr-preprocessing";
import {
  reconcileRecognizedSymbols,
  recognizeSimpleSymbolsFromCanvases,
  type RecognizedSymbol,
} from "./symbol-recognition";
import { correctOcrTexts, getOcrWordChecker, type OcrEvidence, type TextCorrection } from "./text-correction";

type OcrEngine = "paddle" | "dehtr" | "tesseract";
type EvidenceScope = "note" | "line";

export type NoteOcrResult = {
  id: string;
  text: string;
  confidence: number;
  rawText: string;
  rawConfidence: number;
  corrections: TextCorrection[];
  engine: OcrEngine | "none";
  alternatives?: OcrEvidence[];
  symbols?: RecognizedSymbol[];
};

export type OcrEngineDiagnostics = {
  status: "ready" | "partial" | "skipped" | "failed";
  attempts: number;
  candidateCount: number;
  elapsedMs: number;
  error?: string;
};

export type OcrRunDiagnostics = {
  paddle: OcrEngineDiagnostics;
  dehtr: OcrEngineDiagnostics;
  tesseract: OcrEngineDiagnostics;
  degraded: boolean;
};

export type NoteOcrBatchResult = {
  results: NoteOcrResult[];
  diagnostics: OcrRunDiagnostics;
  symbolCount: number;
};

type OcrCandidate = {
  text: string;
  confidence: number;
  engine: OcrEngine;
  variant: string;
  scope: EvidenceScope;
  lineIndex?: number;
  agreement?: number;
  stability?: number;
};

export type PaddleItem = {
  poly: Array<[number, number]>;
  text: string;
  score: number;
};

type PaddleResult = { items: PaddleItem[] };
type PaddleRunner = {
  initialize: () => Promise<unknown>;
  predict: (input: unknown, params?: Record<string, unknown>) => Promise<PaddleResult[]>;
  dispose: () => Promise<void>;
  transportClient?: { dispose: () => void };
};

const PADDLE_INIT_TIMEOUT_MS = 120_000;
let paddleRunnerPromise: Promise<PaddleRunner> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: string) {
  return value
    .replace(/[|]{2,}/g, "I")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textQuality(candidate: OcrCandidate) {
  const text = candidate.text.trim();
  if (!text) return -100;
  const useful = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const junk = (text.match(/[^\p{L}\p{N}\s.,:;!?()\-/&+%]/gu) ?? []).length;
  const junkRatio = junk / Math.max(1, text.length);
  const repeated = /(.)\1{4,}/u.test(text) ? 16 : 0;
  const linePenalty = Math.max(0, text.split("\n").length - 6) * 7;
  if (useful < 2) return candidate.confidence * 0.25 - 30;
  return candidate.confidence + Math.min(12, useful * 0.28) - junkRatio * 65 - repeated - linePenalty;
}

function lexicalPlausibility(candidate: OcrCandidate, isKnown: (word: string) => boolean) {
  const words = candidate.text.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  if (!words.length) return 0;
  const known = words.filter((word) => isKnown(word)).length / words.length;
  const fragments = words.filter((word) => word.length <= 2 && !/^(ai|api|hr|it|qa|ui|ux)$/iu.test(word)).length / words.length;
  return clamp(known - fragments * 0.45, 0, 1);
}

function visualContextFromBands(bands: ReturnType<typeof detectTextLineBands>): FusionContext {
  return {
    expectedLineCount: Math.max(1, bands.length),
    expectedCharacters: Math.max(2, Math.round(bands.reduce((sum, band) => sum + clamp((band.width / Math.max(1, band.height)) * 2.2, 2, 18), 0))),
  };
}

function similarity(a: string, b: string) {
  return ocrTextSimilarity(a, b);
}

function chooseCandidate(current: OcrCandidate | null, incoming: OcrCandidate | null) {
  if (!incoming?.text) return current;
  if (!current?.text) return incoming;
  const currentScore = textQuality(current);
  const incomingScore = textQuality(incoming);
  return incomingScore > currentScore ? incoming : current;
}


export function fuseOcrLines(candidates: OcrCandidate[], isKnown: (word: string) => boolean, context: FusionContext = {}) {
  const complete = candidates.filter((candidate) => candidate.scope === "note");
  const fused = fuseCompleteOcrLines(complete.map((candidate) => ({
    engine: candidate.engine,
    variant: candidate.variant,
    text: candidate.text,
    confidence: candidate.confidence,
  })), { isKnown }, context);
  return fused ? { ...fused, scope: "note" as const } : null;
}

function paddleCandidate(
  result: PaddleResult | undefined,
  variant = "paddle-rgb",
  scope: EvidenceScope = "note",
  lineIndex?: number,
): OcrCandidate | null {
  const items = (result?.items ?? []).filter((item) => cleanText(item.text));
  if (!items.length) return null;
  const text = groupPaddleItemsIntoText(items);
  const weightedLength = items.reduce((sum, item) => sum + Math.max(1, cleanText(item.text).length), 0);
  const confidence = Math.round(
    (items.reduce((sum, item) => sum + clamp(item.score, 0, 1) * Math.max(1, cleanText(item.text).length), 0) / Math.max(1, weightedLength)) * 100,
  );
  return text ? { text, confidence, engine: "paddle", variant, scope, lineIndex, agreement: 0 } : null;
}

export function groupPaddleItemsIntoText(items: PaddleItem[]) {
  type PositionedItem = {
    item: PaddleItem;
    x: number;
    centerY: number;
    minY: number;
    maxY: number;
    height: number;
  };
  type TextRow = {
    items: PositionedItem[];
    centerY: number;
    minY: number;
    maxY: number;
  };
  const positioned = items
    .filter((item) => cleanText(item.text) && item.poly.length >= 3)
    .map((item): PositionedItem => {
      const xs = item.poly.map(([x]) => x);
      const ys = item.poly.map(([, y]) => y);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        item,
        x: Math.min(...xs),
        centerY: (minY + maxY) / 2,
        minY,
        maxY,
        height: Math.max(1, maxY - minY),
      };
    })
    .sort((left, right) => left.centerY - right.centerY || left.x - right.x);
  const rows: TextRow[] = [];
  for (const entry of positioned) {
    const row = rows
      .map((candidate) => {
        const rowHeight = Math.max(1, candidate.maxY - candidate.minY);
        const overlap = Math.max(0, Math.min(candidate.maxY, entry.maxY) - Math.max(candidate.minY, entry.minY));
        const overlapRatio = overlap / Math.max(1, Math.min(rowHeight, entry.height));
        const centerDistance = Math.abs(candidate.centerY - entry.centerY);
        const sameLine = overlapRatio >= 0.3 || centerDistance <= Math.max(8, Math.min(rowHeight, entry.height) * 0.55);
        return { candidate, sameLine, centerDistance };
      })
      .filter((match) => match.sameLine)
      .sort((left, right) => left.centerDistance - right.centerDistance)[0]?.candidate;
    if (!row) {
      rows.push({ items: [entry], centerY: entry.centerY, minY: entry.minY, maxY: entry.maxY });
      continue;
    }
    row.items.push(entry);
    row.minY = Math.min(row.minY, entry.minY);
    row.maxY = Math.max(row.maxY, entry.maxY);
    row.centerY = row.items.reduce((sum, current) => sum + current.centerY, 0) / row.items.length;
  }
  return cleanText(rows
    .sort((left, right) => left.centerY - right.centerY)
    .map((row) => row.items.sort((left, right) => left.x - right.x)
      .map(({ item }) => cleanText(item.text).replace(/\n+/g, " "))
      .join(" "))
    .join("\n"));
}


function orderedPaddleItems(result: PaddleResult | undefined) {
  return [...(result?.items ?? [])]
    .filter((item) => cleanText(item.text) && item.poly.length >= 3 && item.poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))
    .sort((left, right) => {
      const leftY = Math.min(...left.poly.map((point) => point[1]));
      const rightY = Math.min(...right.poly.map((point) => point[1]));
      return leftY - rightY;
    });
}

function createExpandedPaddleLineCrop(source: HTMLCanvasElement, item: PaddleItem) {
  const xs = item.poly.map((point) => point[0]);
  const ys = item.poly.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 2 || height < 2) return null;
  const x = clamp(minX - Math.max(10, width * 0.18), 0, source.width - 1);
  const y = clamp(minY - Math.max(6, height * 0.18), 0, source.height - 1);
  const right = clamp(maxX + Math.max(10, width * 0.18), x + 1, source.width);
  const bottom = clamp(maxY + Math.max(6, height * 0.18), y + 1, source.height);
  const cropWidth = right - x;
  const cropHeight = bottom - y;
  const scale = clamp(Math.min(96 / cropHeight, 1250 / cropWidth), 1, 3);
  const border = 12;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropWidth * scale) + border * 2;
  canvas.height = Math.round(cropHeight * scale) + border * 2;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, x, y, cropWidth, cropHeight, border, border, canvas.width - border * 2, canvas.height - border * 2);
  return canvas;
}
async function getPaddleRunner(report: (progress: number, label: string) => void) {
  if (!paddleRunnerPromise) {
    report(41, "Lokales Handschrift-Modell wird geladen");
    paddleRunnerPromise = (async (): Promise<PaddleRunner> => {
      let runner: PaddleRunner | null = null;
      let cancelled = false;
      let timeout: number | undefined;
      const statusTimers = [
        window.setTimeout(() => report(41, "KI-Laufzeit wird auf diesem Ger\u00e4t eingerichtet"), 15_000),
        window.setTimeout(() => report(41, "Modelle werden entpackt und vorbereitet"), 40_000),
        window.setTimeout(() => report(41, "Modellstart dauert l\u00e4nger \u2013 Abbruch nach 2 Minuten"), 80_000),
      ];
      const stopRunner = () => {
        runner?.transportClient?.dispose();
        if (runner) void runner.dispose().catch(() => undefined);
      };
      const startup = (async () => {
        const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
        if (cancelled) throw new Error("KI-Modellstart wurde abgebrochen.");
        runner = await PaddleOCR.create({
          lang: "de",
          ocrVersion: "PP-OCRv6",
          textDetectionModelName: "PP-OCRv6_small_det",
          textDetectionModelAsset: { url: "/ocr-models/PP-OCRv6_small_det_onnx_infer.tar" },
          textRecognitionModelName: "PP-OCRv6_medium_rec",
          textRecognitionModelAsset: { url: "/ocr-models/PP-OCRv6_medium_rec_onnx_infer.tar" },
          // Vite injects its HMR client into package workers during development;
          // production bundles are clean and keep OCR off the UI thread.
          worker: import.meta.env.PROD,
          initialize: false,
          textDetectionBatchSize: 1,
          textRecognitionBatchSize: 8,
          ortOptions: {
            backend: "wasm",
            numThreads: 1,
            simd: true,
            ...(import.meta.env.PROD ? { wasmPaths: "/onnx-paddle-1.24.3/" } : {}),
          },
        }) as unknown as PaddleRunner;
        if (cancelled) {
          stopRunner();
          throw new Error("KI-Modellstart wurde abgebrochen.");
        }
        await runner.initialize();
        if (cancelled) {
          stopRunner();
          throw new Error("KI-Modellstart wurde abgebrochen.");
        }
        return runner;
      })();

      const deadline = new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          cancelled = true;
          stopRunner();
          reject(new Error("Das lokale KI-Modell konnte nicht innerhalb von 2 Minuten starten."));
        }, PADDLE_INIT_TIMEOUT_MS);
      });
      try {
        return await Promise.race([startup, deadline]);
      } catch (error) {
        cancelled = true;
        stopRunner();
        void startup.catch(() => undefined);
        throw error;
      } finally {
        statusTimers.forEach((timer) => window.clearTimeout(timer));
        if (timeout !== undefined) window.clearTimeout(timeout);
      }
    })()
      .catch((error) => {
        paddleRunnerPromise = null;
        throw error;
      });
  }
  return paddleRunnerPromise;
}

function paddleBatchSize() {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarsePointer || deviceMemory <= 4 || navigator.hardwareConcurrency <= 4 ? 1 : 2;
}

function yieldToUi() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

const PADDLE_PARAMS = {
  textDetLimitSideLen: 1280,
  textDetLimitType: "max",
  textDetMaxSideLimit: 1600,
  textDetThresh: 0.25,
  textDetBoxThresh: 0.48,
  textDetUnclipRatio: 1.65,
  textRecScoreThresh: 0.32,
};

const PADDLE_RELAXED_PARAMS = {
  ...PADDLE_PARAMS,
  textDetThresh: 0.18,
  textDetBoxThresh: 0.3,
  textDetUnclipRatio: 2,
  textRecScoreThresh: 0.12,
};

async function recognizeWithPaddle(
  image: HTMLImageElement,
  notes: NoteRegion[],
  report: (progress: number, label: string) => void,
  recordEvidence: (id: string, candidate: OcrCandidate | null) => void,
  recordSymbols: (id: string, crops: ReturnType<typeof prepareNoteCrops>) => void,
) {
  const runner = await getPaddleRunner(report);
  const candidates = new Map<string, OcrCandidate>();
  const isKnownWord = await getOcrWordChecker().catch(() => () => false);
  const batchSize = paddleBatchSize();
  let successfulBatches = 0;
  let failedBatches = 0;
  let firstFailure: Error | null = null;

  for (let start = 0; start < notes.length; start += batchSize) {
    const batch = notes.slice(start, start + batchSize);
    const prepared = batch.map((note) => ({ note, crops: prepareNoteCrops(image, note) }));
    prepared.forEach((entry) => recordSymbols(entry.note.id, entry.crops));
    const noteCandidates = new Map<string, OcrCandidate[]>();
    const lineCanvases: HTMLCanvasElement[] = [];
    const remember = (note: NoteRegion, candidate: OcrCandidate | null) => {
      if (!candidate) return;
      noteCandidates.set(note.id, [...(noteCandidates.get(note.id) ?? []), candidate]);
      recordEvidence(note.id, candidate);
    };
    const readVariant = async (
      variant: "rgb" | "gray" | "contrast" | "sauvola" | "ink",
      targets: Array<{ note: NoteRegion; crops: ReturnType<typeof prepareNoteCrops> }>,
      params: typeof PADDLE_PARAMS,
    ) => {
      if (!targets.length) return [];
      const results = await runner.predict(targets.map((entry) => entry.crops[variant]), params);
      targets.forEach((entry, index) => remember(entry.note, paddleCandidate(results[index], `paddle-${variant}`)));
      return results;
    };

    report(45 + Math.round((start / Math.max(1, notes.length)) * 34), `Originale Notiz-Crops ${start + 1}–${Math.min(notes.length, start + batch.length)} werden gelesen`);
    try {
      await readVariant("rgb", prepared, PADDLE_PARAMS);
      report(50 + Math.round((start / Math.max(1, notes.length)) * 28), "Schatten werden entfernt und Kontrast wird geprüft");
      const contrastResults = await readVariant("contrast", prepared, PADDLE_PARAMS);
      successfulBatches += 1;
      const needsMoreEvidence = (entry: typeof prepared[number]) => {
        const readings = noteCandidates.get(entry.note.id) ?? [];
        const current = fuseOcrLines(readings, isKnownWord)
          ?? readings.reduce<OcrCandidate | null>((best, candidate) => chooseCandidate(best, candidate), null);
        const agreement = Math.max(0, ...readings.flatMap((candidate, index) => readings.slice(index + 1)
          .map((peer) => similarity(candidate.text, peer.text))));
        return !current || agreement < 0.62 || textQuality(current) < 62
          || current.confidence < 74 && agreement < 0.86;
      };
      const weak = prepared.filter(needsMoreEvidence);

      if (weak.length) {
        report(64 + Math.round((start / Math.max(1, notes.length)) * 18), `${weak.length} schwierige Notizen werden mit Graustufen geprüft`);
        await readVariant("gray", weak, PADDLE_RELAXED_PARAMS);
        report(69 + Math.round((start / Math.max(1, notes.length)) * 14), "Adaptive Schwarzweißmaske wird gelesen");
        await readVariant("sauvola", weak, PADDLE_RELAXED_PARAMS);
        const inkTargets = weak.filter(needsMoreEvidence);
        if (inkTargets.length) {
          report(73 + Math.round((start / Math.max(1, notes.length)) * 11), "Papierfarbe wird entfernt – nur die Tinte bleibt");
          await readVariant("ink", inkTargets, PADDLE_RELAXED_PARAMS);
        }
      }

      const lineJobs: Array<{ note: NoteRegion; order: number; canvas: HTMLCanvasElement }> = [];
      weak.filter(needsMoreEvidence).forEach((entry) => {
        const bands = detectTextLineBands(entry.crops.sauvola);
        if (bands.length) {
          bands.forEach((band) => {
            const canvas = createTextLineCrop(entry.crops.contrast, band);
            lineCanvases.push(canvas);
            lineJobs.push({ note: entry.note, order: band.order, canvas });
          });
          return;
        }
        const index = prepared.indexOf(entry);
        orderedPaddleItems(contrastResults[index]).slice(0, 8).forEach((item, order) => {
          const canvas = createExpandedPaddleLineCrop(entry.crops.contrast, item);
          if (!canvas) return;
          lineCanvases.push(canvas);
          lineJobs.push({ note: entry.note, order, canvas });
        });
      });

      const recovered = new Map<string, Array<{ order: number; candidate: OcrCandidate }>>();
      for (let lineStart = 0; lineStart < lineJobs.length; lineStart += batchSize) {
        const jobs = lineJobs.slice(lineStart, lineStart + batchSize);
        const lineResults = await runner.predict(jobs.map((job) => job.canvas), { ...PADDLE_RELAXED_PARAMS, textDetUnclipRatio: 1.45 });
        jobs.forEach((job, index) => {
          const incoming = paddleCandidate(lineResults[index], "paddle-line-contrast", "line", job.order);
          if (!incoming) return;
          incoming.text = cleanText(incoming.text).replace(/\n+/g, " ");
          recordEvidence(job.note.id, incoming);
          recovered.set(job.note.id, [...(recovered.get(job.note.id) ?? []), { order: job.order, candidate: incoming }]);
        });
        report(78 + Math.round((Math.min(lineJobs.length, lineStart + jobs.length) / Math.max(1, lineJobs.length)) * 6), `Textzeilen ${Math.min(lineJobs.length, lineStart + jobs.length)} von ${lineJobs.length} einzeln gelesen`);
        await yieldToUi();
      }
      recovered.forEach((lines, noteId) => {
        const ordered = lines.sort((left, right) => left.order - right.order).map((entry) => entry.candidate);
        const text = cleanText(ordered.map((candidate) => candidate.text).join("\n"));
        const weight = ordered.reduce((sum, candidate) => sum + Math.max(1, candidate.text.length), 0);
        const confidence = Math.round(ordered.reduce((sum, candidate) => sum + candidate.confidence * Math.max(1, candidate.text.length), 0) / Math.max(1, weight));
        const aggregate: OcrCandidate = { text, confidence, engine: "paddle", variant: "paddle-line-aggregate", scope: "note" };
        const note = batch.find((entry) => entry.id === noteId);
        if (note) remember(note, aggregate);
      });

      for (const note of batch) {
        const readings = noteCandidates.get(note.id) ?? [];
        const selected = fuseOcrLines(readings, isKnownWord)
          ?? readings.reduce<OcrCandidate | null>((best, candidate) => chooseCandidate(best, candidate), null);
        if (!selected) continue;
        const stability = Math.max(0, ...readings.filter((candidate) => candidate !== selected)
          .map((candidate) => similarity(selected.text, candidate.text)));
        const finalCandidate = { ...selected, agreement: 0, stability, scope: "note" as const };
        candidates.set(note.id, finalCandidate);
        recordEvidence(note.id, finalCandidate);
      }
      const completed = Math.min(notes.length, start + batch.length);
      report(84, `${completed} von ${notes.length} Notizen mit Bildfiltern gelesen`);
    } catch (error) {
      failedBatches += 1;
      firstFailure ??= error instanceof Error ? error : new Error(String(error));
      console.warn(`PaddleOCR-Batch ab ${start + 1} fehlgeschlagen`, error);
    } finally {
      lineCanvases.forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
      prepared.forEach((entry) => disposePreparedNoteCrops(entry.crops));
    }
    await yieldToUi();
  }
  if (!successfulBatches) throw new Error("PaddleOCR konnte keine Notiz verarbeiten.");

  return {
    candidates,
    failureCount: failedBatches,
    error: firstFailure?.message,
  };
}

async function recognizeWithDehtr(
  image: HTMLImageElement,
  notes: NoteRegion[],
  existing: Map<string, OcrCandidate>,
  report: (progress: number, label: string) => void,
  recordEvidence: (id: string, candidate: OcrCandidate | null) => void,
  recordSymbols: (id: string, crops: ReturnType<typeof prepareNoteCrops>) => void,
) {
  const startedAt = performance.now();
  const isKnownWord = await getOcrWordChecker().catch(() => () => false);
  const orderedNotes = notes.filter((note) => {
    const current = existing.get(note.id);
    return !current || (current.stability ?? 0) < 0.7 || lexicalPlausibility(current, isKnownWord) < 0.55
      || textQuality(current) < 64 || current.confidence < 70;
  }).sort((left, right) => {
    const priority = (note: NoteRegion) => {
      const current = existing.get(note.id);
      if (!current) return 100;
      return (1 - (current.stability ?? 0)) * 35 + (1 - lexicalPlausibility(current, isKnownWord)) * 30
        + Math.max(0, 70 - current.confidence) * 0.5 + Math.max(0, 64 - textQuality(current)) * 0.25;
    };
    return priority(right) - priority(left);
  });
  if (!orderedNotes.length) return { attempts: 0, candidateCount: 0, failureCount: 0, elapsedMs: performance.now() - startedAt };

  let attempts = 0;
  let candidateCount = 0;
  let failureCount = 0;
  let firstFailure: Error | null = null;

  report(85, `Unabhängiges Handschriftmodell prüft alle ${orderedNotes.length} Notizen`);
  for (let noteIndex = 0; noteIndex < orderedNotes.length; noteIndex += 1) {
    const note = orderedNotes[noteIndex];
    const prepared = prepareNoteCrops(image, note);
    recordSymbols(note.id, prepared);
    const lineCanvases: HTMLCanvasElement[] = [];
    try {
      const bands = detectTextLineBands(prepared.sauvola);
      if (!bands.length) continue;
      const lines: Array<{ order: number; candidate: OcrCandidate }> = [];
      for (let lineIndex = 0; lineIndex < bands.length; lineIndex += 1) {
        attempts += 1;
        const band = bands[lineIndex];
        const lineContext = visualContextFromBands([band]);
        const rawLine = createTextLineCrop(prepared.rgb, band, 82);
        lineCanvases.push(rawLine);
        const first = await recognizeHandwrittenLine(rawLine);
        let best: OcrCandidate | null = first.text ? {
          text: cleanText(first.text),
          confidence: first.confidence,
          engine: "dehtr",
          variant: "dehtr-rgb",
          scope: "line",
          lineIndex,
        } : null;
        recordEvidence(note.id, best);

        if (!best || assessOcrText(best, { isKnown: isKnownWord }, lineContext) < 0.62) {
          const contrastLine = createTextLineCrop(prepared.contrast, band, 82);
          lineCanvases.push(contrastLine);
          const second = await recognizeHandwrittenLine(contrastLine);
          const alternative: OcrCandidate | null = second.text ? {
            text: cleanText(second.text),
            confidence: second.confidence,
            engine: "dehtr",
            variant: "dehtr-contrast",
            scope: "line",
            lineIndex,
          } : null;
          recordEvidence(note.id, alternative);
          if (best && alternative) {
            const bestQuality = assessOcrText(best, { isKnown: isKnownWord }, lineContext);
            const alternativeQuality = assessOcrText(alternative, { isKnown: isKnownWord }, lineContext);
            best = alternativeQuality > bestQuality ? alternative : best;
          } else if (!best) best = alternative;
        }
        if (best) {
          candidateCount += 1;
          lines.push({ order: lineIndex, candidate: best });
        }
        report(85 + Math.round(((noteIndex + (lineIndex + 1) / bands.length) / orderedNotes.length) * 9), `Handschrift-Zeilen ${lineIndex + 1} von ${bands.length} auf Notiz ${noteIndex + 1}/${orderedNotes.length}`);
        await yieldToUi();
      }
      if (!lines.length) continue;
      const ordered = lines.sort((left, right) => left.order - right.order).map((entry) => entry.candidate);
      const text = cleanText(ordered.map((entry) => entry.text).join("\n"));
      const weight = ordered.reduce((sum, entry) => sum + Math.max(1, entry.text.length), 0);
      const confidence = Math.round(ordered.reduce((sum, entry) => sum + entry.confidence * Math.max(1, entry.text.length), 0) / Math.max(1, weight));
      const incoming: OcrCandidate = { text, confidence, engine: "dehtr", variant: "dehtr-line-aggregate", scope: "note" };
      recordEvidence(note.id, incoming);
      const current = existing.get(note.id) ?? null;
      if (!current) {
        existing.set(note.id, incoming);
        continue;
      }
      const context = visualContextFromBands(bands);
      const fused = fuseOcrLines([current, incoming], isKnownWord, context);
      if (fused) existing.set(note.id, { ...fused, stability: current.stability });
    } catch (error) {
      failureCount += 1;
      firstFailure ??= error instanceof Error ? error : new Error(String(error));
      console.warn(`DE·HTR-Gegenprüfung für ${note.id} fehlgeschlagen`, error);
    } finally {
      lineCanvases.forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
      disposePreparedNoteCrops(prepared);
    }
  }
  if (!candidateCount && firstFailure) throw firstFailure;
  return { attempts, candidateCount, failureCount, elapsedMs: performance.now() - startedAt, error: firstFailure?.message };
}

async function recognizeWithTesseract(
  image: HTMLImageElement,
  notes: NoteRegion[],
  existing: Map<string, OcrCandidate>,
  report: (progress: number, label: string) => void,
  recordEvidence: (id: string, candidate: OcrCandidate | null) => void,
  recordSymbols: (id: string, crops: ReturnType<typeof prepareNoteCrops>) => void,
) {
  const startedAt = performance.now();
  const fallbackNotes = notes;
  if (!fallbackNotes.length) return { attempts: 0, candidateCount: 0, elapsedMs: 0 };

  const isKnownWord = await getOcrWordChecker().catch(() => () => false);
  report(95, "Letzte lokale Ersatzlesung wird geladen");
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  let active = 0;
  let activePass = 0;
  let candidateCount = 0;
  let failureCount = 0;
  let firstFailure: Error | null = null;
  const worker = await createWorker(["deu", "eng"], OEM.LSTM_ONLY, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract-core/",
    langPath: "/tessdata",
    logger: (message) => {
      if (message.status === "recognizing text") {
        const progress = 95 + ((active + (activePass + message.progress) / 2) / Math.max(1, fallbackNotes.length)) * 3;
        report(Math.min(98, Math.round(progress)), `Gegenprüfung ${active + 1} von ${fallbackNotes.length}`);
      }
    },
  });

  try {
    for (active = 0; active < fallbackNotes.length; active += 1) {
      const note = fallbackNotes[active];
      let prepared: ReturnType<typeof prepareNoteCrops> | null = null;
      try {
        prepared = prepareNoteCrops(image, note);
        recordSymbols(note.id, prepared);
        activePass = 0;
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
          tessedit_do_invert: "0",
        });
        const first = await worker.recognize(prepared.contrast, {}, { text: true, blocks: true });
        let best: OcrCandidate | null = cleanText(first.data.text)
          ? { text: cleanText(first.data.text), confidence: Math.round(first.data.confidence || 0), engine: "tesseract", variant: "tesseract-block-contrast", scope: "note" }
          : null;
        recordEvidence(note.id, best);

        {
          activePass = 1;
          await worker.setParameters({
            tessedit_pageseg_mode: PSM.SPARSE_TEXT,
            preserve_interword_spaces: "1",
            user_defined_dpi: "300",
            tessedit_do_invert: "0",
          });
          const second = await worker.recognize(prepared.sauvola, {}, { text: true, blocks: true });
          const alternative: OcrCandidate | null = cleanText(second.data.text)
            ? { text: cleanText(second.data.text), confidence: Math.round(second.data.confidence || 0), engine: "tesseract", variant: "tesseract-sparse-sauvola", scope: "note" }
            : null;
          recordEvidence(note.id, alternative);
          const bands = detectTextLineBands(prepared.sauvola);
          best = fuseOcrLines(
            [best, alternative].filter((candidate): candidate is OcrCandidate => Boolean(candidate)),
            isKnownWord,
            visualContextFromBands(bands),
          );
        }
        const current = existing.get(note.id) ?? null;
        if (!best) {
          if (current) existing.set(note.id, current);
          continue;
        }
        const bands = detectTextLineBands(prepared.sauvola);
        const context = visualContextFromBands(bands);
        let selected = current;
        if (!current) selected = best;
        else {
          const currentQuality = assessOcrText(current, { isKnown: isKnownWord }, context);
          const fallbackQuality = assessOcrText(best, { isKnown: isKnownWord }, context);
          const agreement = similarity(current.text, best.text);
          if (agreement >= 0.45 && fallbackQuality >= currentQuality - 0.08) {
            selected = fuseOcrLines([current, best], isKnownWord, context) ?? chooseCandidate(current, best);
          } else if (fallbackQuality >= currentQuality + 0.22) selected = best;
        }
        if (selected) {
          existing.set(note.id, selected);
          candidateCount += 1;
        }
      } catch (error) {
        failureCount += 1;
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
        console.warn(`OCR-Gegenprüfung für ${note.id} fehlgeschlagen`, error);
      } finally {
        if (prepared) disposePreparedNoteCrops(prepared);
      }
    }
  } finally {
    await worker.terminate();
  }
  return {
    attempts: fallbackNotes.length,
    candidateCount,
    failureCount,
    elapsedMs: performance.now() - startedAt,
    error: firstFailure?.message,
  };
}

export async function recognizeNoteTexts(
  image: HTMLImageElement,
  notes: NoteRegion[],
  report: (progress: number, label: string) => void,
): Promise<NoteOcrBatchResult> {
  const candidates = new Map<string, OcrCandidate>();
  const evidenceById = new Map<string, OcrEvidence[]>();
  const symbolsById = new Map<string, RecognizedSymbol[]>();
  const emptyDiagnostics = (): OcrEngineDiagnostics => ({ status: "skipped", attempts: 0, candidateCount: 0, elapsedMs: 0 });
  const diagnostics: OcrRunDiagnostics = {
    paddle: emptyDiagnostics(),
    dehtr: emptyDiagnostics(),
    tesseract: emptyDiagnostics(),
    degraded: false,
  };
  const recordEvidence = (id: string, candidate: OcrCandidate | null) => {
    if (!candidate?.text.trim()) return;
    const evidence: OcrEvidence = {
      text: cleanText(candidate.text),
      confidence: Math.round(clamp(candidate.confidence, 0, 100)),
      engine: candidate.engine,
      variant: candidate.variant,
      scope: candidate.scope,
      lineIndex: candidate.lineIndex,
    };
    const current = evidenceById.get(id) ?? [];
    evidenceById.set(id, mergeOcrEvidence(current, evidence));
  };
  const recordSymbols = (id: string, crops: ReturnType<typeof prepareNoteCrops>) => {
    if (symbolsById.has(id)) return;
    try {
      symbolsById.set(id, recognizeSimpleSymbolsFromCanvases(crops.sauvola, crops.ink, crops.contrast));
    } catch (error) {
      symbolsById.set(id, []);
      console.warn(`Symbolerkennung für ${id} fehlgeschlagen`, error);
    }
  };
  const paddleStartedAt = performance.now();
  try {
    const paddle = await recognizeWithPaddle(image, notes, report, recordEvidence, recordSymbols);
    paddle.candidates.forEach((candidate, id) => { candidates.set(id, candidate); recordEvidence(id, candidate); });
    diagnostics.paddle = {
      status: paddle.failureCount ? "partial" : "ready",
      attempts: notes.length,
      candidateCount: paddle.candidates.size,
      elapsedMs: performance.now() - paddleStartedAt,
      error: paddle.error,
    };
  } catch (error) {
    diagnostics.paddle = {
      status: "failed",
      attempts: notes.length,
      candidateCount: 0,
      elapsedMs: performance.now() - paddleStartedAt,
      error: errorMessage(error),
    };
    console.warn("PaddleOCR ist nicht verfügbar; die Ersatzmodelle übernehmen.", error);
  }

  try {
    const dehtr = await recognizeWithDehtr(image, notes, candidates, report, recordEvidence, recordSymbols);
    diagnostics.dehtr = {
      status: dehtr.failureCount ? "partial" : dehtr.attempts ? "ready" : "skipped",
      ...dehtr,
    };
  } catch (error) {
    diagnostics.dehtr = {
      status: "failed",
      attempts: 1,
      candidateCount: 0,
      elapsedMs: 0,
      error: errorMessage(error),
    };
    console.warn("Das zweite Handschriftmodell ist nicht verfügbar.", error);
  }

  const fallbackIsKnown = await getOcrWordChecker().catch(() => () => false);
  const tesseractNotes = notes.filter((note) => {
    const candidate = candidates.get(note.id);
    return !candidate || !candidate.text.trim() || candidate.confidence < 70 || textQuality(candidate) < 45
      || lexicalPlausibility(candidate, fallbackIsKnown) < 0.5;
  });
  if (tesseractNotes.length) {
    try {
      const tesseract = await recognizeWithTesseract(image, tesseractNotes, candidates, report, recordEvidence, recordSymbols);
      diagnostics.tesseract = { status: tesseract.failureCount ? "partial" : "ready", ...tesseract };
    } catch (error) {
      diagnostics.tesseract = {
        status: "failed",
        attempts: tesseractNotes.length,
        candidateCount: 0,
        elapsedMs: 0,
        error: errorMessage(error),
      };
      console.warn("Tesseract-Ersatz ist nicht verfügbar.", error);
    }
  }

  report(99, "Textergebnisse werden zusammengeführt");
  const rawResults: NoteOcrResult[] = notes.map((note) => {
    const candidate = candidates.get(note.id);
    if (!candidate?.text) return { id: note.id, text: "", confidence: 0, rawText: "", rawConfidence: 0, corrections: [], engine: "none" };
    const confidence = Math.round(clamp(candidate.confidence, 1, 99));
    const text = cleanText(candidate.text);
    return {
      id: note.id,
      text,
      confidence,
      rawText: text,
      rawConfidence: confidence,
      corrections: [],
      engine: candidate.engine,
      alternatives: evidenceById.get(note.id) ?? [],
    };
  });
  let results = rawResults;
  try {
    report(99, "Kauderwelsch wird mit OCR-Lesarten und Wörterbüchern gerettet");
    results = await correctOcrTexts(rawResults, (completed, total) => {
      report(99, `Text-Rettung ${completed} von ${total}`);
    });
  } catch (error) {
    console.warn("Lokale Textkorrektur ist nicht verfügbar.", error);
  }
  results = results.map((result) => {
    const symbols = symbolsById.get(result.id) ?? [];
    if (!symbols.length) return { ...result, symbols };
    const mergedText = reconcileRecognizedSymbols(result.text, symbols);
    const mergedRawText = reconcileRecognizedSymbols(result.rawText, symbols);
    const hadText = Boolean(result.text.trim()) && mergedText !== symbols.map((symbol) => symbol.symbol).join(" ");
    const symbolConfidence = Math.round(symbols.reduce((sum, symbol) => sum + symbol.confidence, 0) / symbols.length);
    return {
      ...result,
      text: mergedText,
      rawText: mergedRawText,
      confidence: hadText ? result.confidence : symbolConfidence,
      rawConfidence: result.rawText.trim() ? result.rawConfidence : symbolConfidence,
      symbols,
    };
  });
  diagnostics.degraded = [diagnostics.paddle.status, diagnostics.dehtr.status].some((status) => status === "failed" || status === "partial");
  return { results, diagnostics, symbolCount: [...symbolsById.values()].reduce((sum, symbols) => sum + symbols.length, 0) };
}

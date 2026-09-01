"use client";

import dehtrWorkerUrl from "./dehtr.worker.ts?worker&url";

export type DehtrResult = {
  text: string;
  confidence: number;
  elapsedMs: number;
};

type PendingJob = {
  resolve: (value: DehtrResult) => void;
  reject: (reason: Error) => void;
  timeout: number;
};

type WorkerResponse = ({ type: "result"; id: number } & DehtrResult) | { type: "error"; id: number; message: string };

let worker: Worker | null = null;
let nextJobId = 1;
let queue: Promise<unknown> = Promise.resolve();
let warmupPromise: Promise<void> | null = null;
const pending = new Map<number, PendingJob>();

function resetWorker(reason: Error) {
  worker?.terminate();
  worker = null;
  for (const job of pending.values()) {
    window.clearTimeout(job.timeout);
    job.reject(reason);
  }
  pending.clear();
}

function getWorker() {
  if (!worker) {
    // Vinext can render `new URL("./worker", import.meta.url)` against its
    // server-side file:// build root. Importing the emitted URL explicitly and
    // resolving it against the current HTTP origin keeps the worker loadable in
    // the production browser as well as during local development.
    worker = new Worker(new URL(dehtrWorkerUrl, window.location.origin), { type: "module", name: "dehtr-handwriting" });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      window.clearTimeout(job.timeout);
      if (event.data.type === "error") job.reject(new Error(event.data.message));
      else job.resolve({ text: event.data.text, confidence: event.data.confidence, elapsedMs: event.data.elapsedMs });
    });
    worker.addEventListener("error", () => resetWorker(new Error("Das zweite Handschriftmodell wurde unerwartet beendet.")));
  }
  return worker;
}

function preprocessLine(canvas: HTMLCanvasElement) {
  const imageHeight = 64;
  const maxWidth = 1024;
  const resizedWidth = Math.max(1, Math.round(canvas.width * (imageHeight / Math.max(1, canvas.height))));
  const imageWidth = Math.min(resizedWidth, maxWidth);
  const width = Math.min(maxWidth, Math.ceil(imageWidth / 4) * 4);
  const drawnHeight = resizedWidth > maxWidth
    ? Math.max(1, Math.round(imageHeight * (maxWidth / resizedWidth)))
    : imageHeight;
  const top = Math.floor((imageHeight - drawnHeight) / 2);
  const resized = document.createElement("canvas");
  resized.width = width;
  resized.height = imageHeight;
  const context = resized.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("Canvas-Vorverarbeitung für DE·HTR ist nicht verfügbar.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, imageHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, top, imageWidth, drawnHeight);
  const pixels = context.getImageData(0, 0, width, imageHeight).data;
  const values = new Float32Array(width * imageHeight);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    values[index] = (pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114) / 255;
  }
  resized.width = 1;
  resized.height = 1;
  return { values, width };
}

function recognizeNow(canvas: HTMLCanvasElement) {
  const { values, width } = preprocessLine(canvas);
  const id = nextJobId;
  nextJobId += 1;
  return new Promise<DehtrResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      resetWorker(new Error("Das zweite Handschriftmodell hat zu lange gebraucht."));
    }, 45_000);
    pending.set(id, { resolve, reject, timeout });
    getWorker().postMessage({ type: "recognize", id, width, values }, [values.buffer]);
  });
}

export function recognizeHandwrittenLine(canvas: HTMLCanvasElement) {
  const task = queue.then(() => recognizeNow(canvas));
  queue = task.catch(() => undefined);
  return task;
}

export function preloadDehtrModel() {
  if (!warmupPromise) {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return Promise.resolve();
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    warmupPromise = recognizeHandwrittenLine(canvas)
      .then(() => undefined)
      .finally(() => { canvas.width = 1; canvas.height = 1; })
      .catch((error) => {
        warmupPromise = null;
        throw error;
      });
  }
  return warmupPromise;
}

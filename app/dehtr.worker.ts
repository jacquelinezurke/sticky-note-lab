/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";

type ModelConfig = {
  model: string;
  input_name: string;
  output_name: string;
  image_height: number;
  max_width: number;
  output_stride: number;
  blank_index: number;
  alphabet: string;
};

type RecognizeMessage = {
  type: "recognize";
  id: number;
  width: number;
  values: Float32Array;
};

type WorkerResult = {
  type: "result";
  id: number;
  text: string;
  confidence: number;
  elapsedMs: number;
} | {
  type: "error";
  id: number;
  message: string;
};

let modelPromise: Promise<{ session: ort.InferenceSession; config: ModelConfig; alphabet: string[] }> | null = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = "/onnx-dehtr-1.27/";
      const response = await fetch("/ocr-models/dehtr-v2/config.json");
      if (!response.ok) throw new Error(`DE·HTR-Konfiguration fehlt (${response.status}).`);
      const config = await response.json() as ModelConfig;
      const modelUrl = new URL(config.model, new URL("/ocr-models/dehtr-v2/", self.location.origin)).href;
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return { session, config, alphabet: Array.from(config.alphabet) };
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

function decode(logits: Float32Array, dimensions: readonly number[], validSteps: number, alphabet: string[], blankIndex: number) {
  const classes = dimensions[2];
  const steps = Math.min(validSteps, dimensions[1]);
  const characters: string[] = [];
  const confidences: number[] = [];
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    const offset = step * classes;
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < classes; index += 1) {
      const value = logits[offset + index];
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestIndex !== blankIndex && bestIndex !== previous) {
      let sum = 0;
      for (let index = 0; index < classes; index += 1) sum += Math.exp(logits[offset + index] - bestValue);
      characters.push(alphabet[bestIndex - 1] ?? "");
      confidences.push(1 / Math.max(1, sum));
    }
    previous = bestIndex;
  }
  const confidence = confidences.length
    ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)
    : 0;
  return { text: characters.join("").trim(), confidence };
}

self.addEventListener("message", async (event: MessageEvent<RecognizeMessage>) => {
  if (event.data.type !== "recognize") return;
  const { id, width, values } = event.data;
  try {
    const { session, config, alphabet } = await getModel();
    const input = new ort.Tensor("float32", values, [1, 1, config.image_height, width]);
    const started = performance.now();
    const outputs = await session.run({ [config.input_name]: input });
    const elapsedMs = performance.now() - started;
    const output = outputs[config.output_name];
    if (!output || !(output.data instanceof Float32Array)) throw new Error("DE·HTR hat keine lesbare Ausgabe geliefert.");
    const decoded = decode(output.data, output.dims, Math.ceil(width / config.output_stride), alphabet, config.blank_index);
    const result: WorkerResult = { type: "result", id, ...decoded, elapsedMs };
    self.postMessage(result);
  } catch (error) {
    const result: WorkerResult = {
      type: "error",
      id,
      message: error instanceof Error ? error.message : "DE·HTR-Erkennung fehlgeschlagen.",
    };
    self.postMessage(result);
  }
});

export {};

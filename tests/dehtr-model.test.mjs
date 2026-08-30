import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import * as ort from "onnxruntime-web";

test("bundled DE·HTR v2 model loads and produces CTC logits", async () => {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = `${pathToFileURL(path.resolve("node_modules/onnxruntime-web/dist")).href}/`;
  const model = await readFile("public/ocr-models/dehtr-v2/model.onnx");
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  try {
    const input = new ort.Tensor("float32", new Float32Array(64 * 64).fill(1), [1, 1, 64, 64]);
    const output = await session.run({ image: input });
    assert.deepEqual(output.logits.dims, [1, 16, 112]);
  } finally {
    await session.release();
  }
});

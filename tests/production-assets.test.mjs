import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sha256 = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(path) : [path];
  }))).flat();
}

test("ships Paddle's exact ONNX Runtime Web 1.24.3 side modules", async () => {
  const directory = new URL("../dist/client/onnx-paddle-1.24.3/", import.meta.url);
  const [loader, wasm] = await Promise.all([
    readFile(new URL("ort-wasm-simd-threaded.jsep.mjs", directory)),
    readFile(new URL("ort-wasm-simd-threaded.jsep.wasm", directory)),
  ]);
  assert.equal(sha256(loader), "9A99ACD12ACC495184C9EA4D458AC9424F8180AACFBC7B8371ED64F9351E4A81");
  assert.equal(sha256(wasm), "2E0A3D0E3F6B7C13ECFABA38C13691FD19C9ED470E72F9D7D8416CA59AB6DBCD");
});

test("ships DEHTR's exact ONNX Runtime Web 1.27 side modules", async () => {
  const directory = new URL("../dist/client/onnx-dehtr-1.27/", import.meta.url);
  const [loader, wasm] = await Promise.all([
    readFile(new URL("ort-wasm-simd-threaded.jsep.mjs", directory)),
    readFile(new URL("ort-wasm-simd-threaded.jsep.wasm", directory)),
  ]);
  assert.equal(sha256(loader), "3EE381D20A80F51A788A1C4A5872F6F1D047538DD4342F4AF00062DE5F9EA4C6");
  assert.equal(sha256(wasm), "78FEEEB3D08F6BCEE94D938ED322F69073BB8076B5F9D34697A574FFBA8DEB48");
});

test("ships the complete Tesseract fallback without CDN dependencies", async () => {
  const required = [
    "tesseract/worker.min.js",
    "tesseract-core/tesseract-core.wasm.js",
    "tesseract-core/tesseract-core-simd.wasm.js",
    "tesseract-core/tesseract-core-lstm.wasm.js",
    "tesseract-core/tesseract-core-simd-lstm.wasm.js",
    "tesseract-core/tesseract-core-relaxedsimd.wasm.js",
    "tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js",
    "tessdata/deu.traineddata.gz",
    "tessdata/eng.traineddata.gz",
  ];
  for (const path of required) {
    const asset = new URL(`../dist/client/${path}`, import.meta.url);
    assert.ok((await stat(asset)).size > 100_000, `${path} is missing or truncated`);
  }
  const engine = await readFile(new URL("../app/ocr-engine.ts", import.meta.url), "utf8");
  assert.match(engine, /workerPath:\s*"\/tesseract\/worker\.min\.js"/);
  assert.match(engine, /corePath:\s*"\/tesseract-core\/"/);
  assert.match(engine, /langPath:\s*"\/tessdata"/);
});

test("builds a browser-safe DEHTR worker URL", async () => {
  const staticDirectory = new URL("../dist/client/_next/static/", import.meta.url);
  const files = await filesBelow(fileURLToPath(staticDirectory));
  const javascript = files.filter((file) => file.endsWith(".js"));
  const bundles = await Promise.all(javascript.map((file) => readFile(file, "utf8")));
  const joined = bundles.join("\n");
  assert.doesNotMatch(joined, /file:\/\/\/ROOT/);
  const worker = files.find((file) => /dehtr\.worker-.*\.js$/u.test(file.replace(/\\/g, "/")));
  assert.ok(worker, "DEHTR worker bundle is missing");
  assert.ok((await stat(worker)).size > 10_000, "DEHTR worker bundle is unexpectedly small");
  assert.match(joined, /\/_next\/static\/dehtr\.worker-/);
});

test("keeps the real low-resolution board fixture byte-exact", async () => {
  const fixture = await readFile(new URL("./fixtures/postit-board.jpg", import.meta.url));
  assert.equal(fixture.length, 30_213);
  assert.equal(sha256(fixture), "8ECAFFE174E7D595D903CE068730E653164CDCBEC4A624B0BFA6B636BF316345");
});

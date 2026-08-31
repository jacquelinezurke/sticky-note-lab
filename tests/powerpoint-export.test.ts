import assert from "node:assert/strict";
import test from "node:test";

import { createBoardPresentation } from "../app/powerpoint-export.ts";

test("creates a valid PowerPoint package from editable board objects", async () => {
  const pptx = createBoardPresentation({
    aspectRatio: 1.6,
    title: "Workshop Board",
    notes: [
      { id: "one", x: 8, y: 12, width: 22, height: 24, rotation: -8, zIndex: 2, color: "#f7dc68", text: "Erste Idee" },
      { id: "two", x: 52, y: 38, width: 25, height: 21, rotation: 4, zIndex: 3, color: "#a9d9ee", text: "Nächster Schritt" },
    ],
    edges: [{ sourceId: "one", targetId: "two" }],
  });
  const output = await pptx.write({ outputType: "uint8array", compression: true });
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer);
  assert.ok(bytes.length > 10_000);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const directoryText = Buffer.from(bytes).toString("latin1");
  assert.match(directoryText, /ppt\/slides\/slide1\.xml/);
  assert.match(directoryText, /ppt\/presentation\.xml/);
});

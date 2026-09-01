import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpreadsheetRows,
  createBoardCsv,
  createBoardWorkbook,
} from "../app/spreadsheet-export.ts";

const GRID = [
  { id: "c", x: 52, y: 42, width: 18, height: 18, color: "#a9d9ee", text: "Unten rechts" },
  { id: "a", x: 8, y: 10, width: 18, height: 18, color: "#f7dc68", text: "Oben links" },
  { id: "d", x: 9, y: 41, width: 18, height: 18, color: "#b9dfa5", text: "Unten links" },
  { id: "b", x: 51, y: 11, width: 18, height: 18, color: "#f2a3b4", text: "Oben rechts" },
];

test("infers tolerant row and column indices and numbers notes in reading order", () => {
  const result = buildSpreadsheetRows(GRID);
  assert.equal(result.gridRecognized, true);
  assert.deepEqual(result.rows.map(({ number, row, column, text }) => ({ number, row, column, text })), [
    { number: 1, row: 1, column: 1, text: "Oben links" },
    { number: 2, row: 1, column: 2, text: "Oben rechts" },
    { number: 3, row: 2, column: 1, text: "Unten links" },
    { number: 4, row: 2, column: 2, text: "Unten rechts" },
  ]);
  assert.equal(result.rows[0].color, "Gelb");
});

test("leaves row and column empty when a free-form diagonal has no shared axes", () => {
  const notes = Array.from({ length: 4 }, (_, index) => ({
    id: String(index), x: index * 24, y: index * 22, width: 12, height: 12, color: "#f7dc68", text: String(index),
  }));
  const result = buildSpreadsheetRows(notes);
  assert.equal(result.gridRecognized, false);
  assert.ok(result.rows.every((row) => row.row === null && row.column === null));
});

test("creates Excel-friendly semicolon CSV and neutralizes formula injection", () => {
  const csv = createBoardCsv([{ ...GRID[0], text: '=HYPERLINK("https://example.test")' }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"Post-it-Nr\.";"Reihe\/Zeile";"Spalte"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
});

test("creates a valid XLSX package with the Post-its worksheet", async () => {
  const workbook = await createBoardWorkbook(GRID, "Testboard");
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  assert.ok(bytes.length > 5_000);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const directoryText = Buffer.from(bytes).toString("latin1");
  assert.match(directoryText, /xl\/worksheets\/sheet1\.xml/);
  assert.match(directoryText, /xl\/workbook\.xml/);
});

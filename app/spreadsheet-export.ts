export type SpreadsheetNote = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
};

export type SpreadsheetRow = {
  number: number;
  row: number | null;
  column: number | null;
  color: string;
  colorHex: string;
  text: string;
};

type AxisCluster = { center: number; members: SpreadsheetNote[] };

const COLOR_NAMES = [
  { hex: "#f7dc68", name: "Gelb" },
  { hex: "#f2a3b4", name: "Rosa" },
  { hex: "#a9d9ee", name: "Blau" },
  { hex: "#b9dfa5", name: "Grün" },
  { hex: "#cdb8ee", name: "Lila" },
  { hex: "#f2b46d", name: "Orange" },
  { hex: "#f6f0df", name: "Creme/Weiß" },
  { hex: "#d6d8db", name: "Grau" },
] as const;

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function axisCenter(note: SpreadsheetNote, axis: "x" | "y") {
  return axis === "x" ? note.x + note.width / 2 : note.y + note.height / 2;
}

/** Groups slightly staggered note centres without forcing a grid onto a free-form board. */
function clusterAxis(notes: SpreadsheetNote[], axis: "x" | "y") {
  const typicalSize = median(notes.map((note) => axis === "x" ? note.width : note.height));
  const tolerance = Math.max(2.6, typicalSize * 0.38);
  const clusters: AxisCluster[] = [];
  [...notes]
    .sort((left, right) => axisCenter(left, axis) - axisCenter(right, axis))
    .forEach((note) => {
      const center = axisCenter(note, axis);
      let best: AxisCluster | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const cluster of clusters) {
        const distance = Math.abs(center - cluster.center);
        if (distance <= tolerance && distance < bestDistance) {
          best = cluster;
          bestDistance = distance;
        }
      }
      if (!best) {
        clusters.push({ center, members: [note] });
        return;
      }
      best.members.push(note);
      best.center = best.members.reduce((sum, member) => sum + axisCenter(member, axis), 0) / best.members.length;
    });
  return clusters.sort((left, right) => left.center - right.center);
}

function normalizeHex(value: string) {
  const hex = value.trim().replace(/^#/u, "");
  if (/^[0-9a-f]{3}$/iu.test(hex)) return `#${hex.split("").map((digit) => digit + digit).join("")}`.toUpperCase();
  if (/^[0-9a-f]{6}$/iu.test(hex)) return `#${hex}`.toUpperCase();
  return "#F7DC68";
}

function rgb(hex: string) {
  const normalized = normalizeHex(hex).slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

export function readableColorName(value: string) {
  const source = rgb(value);
  return COLOR_NAMES.reduce((best, candidate) => {
    const target = rgb(candidate.hex);
    const distance = Math.hypot(source[0] - target[0], source[1] - target[1], source[2] - target[2]);
    return distance < best.distance ? { name: candidate.name, distance } : best;
  }, { name: "Gelb", distance: Number.POSITIVE_INFINITY }).name;
}

export function buildSpreadsheetRows(notes: SpreadsheetNote[]) {
  if (!notes.length) return { rows: [] as SpreadsheetRow[], gridRecognized: false };
  const rowClusters = clusterAxis(notes, "y");
  const columnClusters = clusterAxis(notes, "x");
  const gridRecognized = notes.length === 1
    || rowClusters.some((cluster) => cluster.members.length >= 2)
    || columnClusters.some((cluster) => cluster.members.length >= 2);
  const rowById = new Map(rowClusters.flatMap((cluster, index) => cluster.members.map((note) => [note.id, index + 1] as const)));
  const columnById = new Map(columnClusters.flatMap((cluster, index) => cluster.members.map((note) => [note.id, index + 1] as const)));
  const ordered = [...notes].sort((left, right) => {
    if (gridRecognized) {
      const rowDifference = (rowById.get(left.id) ?? 0) - (rowById.get(right.id) ?? 0);
      if (rowDifference) return rowDifference;
      const columnDifference = (columnById.get(left.id) ?? 0) - (columnById.get(right.id) ?? 0);
      if (columnDifference) return columnDifference;
    }
    return axisCenter(left, "y") - axisCenter(right, "y") || axisCenter(left, "x") - axisCenter(right, "x") || left.id.localeCompare(right.id);
  });
  return {
    gridRecognized,
    rows: ordered.map((note, index): SpreadsheetRow => ({
      number: index + 1,
      row: gridRecognized ? rowById.get(note.id) ?? null : null,
      column: gridRecognized ? columnById.get(note.id) ?? null : null,
      color: readableColorName(note.color),
      colorHex: normalizeHex(note.color),
      text: note.text,
    })),
  };
}

function protectCsvCell(value: string | number | null) {
  if (value === null) return "";
  let text = String(value);
  // Spreadsheet applications may execute cells beginning with these characters.
  if (/^[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createBoardCsv(notes: SpreadsheetNote[]) {
  const { rows } = buildSpreadsheetRows(notes);
  const records = [
    ["Post-it-Nr.", "Reihe/Zeile", "Spalte", "Farbe", "Farbcode (HEX)", "Text"],
    ...rows.map((row) => [row.number, row.row, row.column, row.color, row.colorHex, row.text]),
  ];
  return `\uFEFF${records.map((record) => record.map(protectCsvCell).join(";")).join("\r\n")}`;
}

export async function createBoardWorkbook(notes: SpreadsheetNote[], title = "Sticky Note Lab Board") {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sticky Note Lab";
  workbook.title = title;
  workbook.subject = "Aus einem Post-it-Board erkannte Daten";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Post-its", {
    views: [{ state: "frozen", ySplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  worksheet.columns = [
    { header: "Post-it-Nr.", key: "number", width: 14 },
    { header: "Reihe/Zeile", key: "row", width: 15 },
    { header: "Spalte", key: "column", width: 12 },
    { header: "Farbe", key: "color", width: 18 },
    { header: "Farbcode (HEX)", key: "colorHex", width: 19 },
    { header: "Text", key: "text", width: 58 },
  ];
  const { rows } = buildSpreadsheetRows(notes);
  rows.forEach((record) => {
    const row = worksheet.addRow(record);
    row.height = 34;
    row.alignment = { vertical: "top", wrapText: true };
    const colorCell = row.getCell(4);
    colorCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${record.colorHex.slice(1)}` } };
    colorCell.font = { bold: true, color: { argb: "FF292923" } };
  });
  const header = worksheet.getRow(1);
  header.height = 27;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle" };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF292923" } };
    cell.border = { bottom: { style: "medium", color: { argb: "FFFF6654" } } };
  });
  worksheet.autoFilter = { from: "A1", to: "F1" };
  worksheet.properties.defaultRowHeight = 22;
  return workbook;
}

export async function createBoardExcelBlob(notes: SpreadsheetNote[], title?: string) {
  const workbook = await createBoardWorkbook(notes, title);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

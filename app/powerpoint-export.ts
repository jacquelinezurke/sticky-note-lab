import pptxgen from "pptxgenjs";

export type PowerPointNote = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
  rotation?: number;
  zIndex?: number;
};

export type PowerPointEdge = { sourceId: string; targetId: string };

export type PowerPointBoard = {
  notes: PowerPointNote[];
  edges: PowerPointEdge[];
  aspectRatio: number;
  title?: string;
};

const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const OUTER_MARGIN = 0.34;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanHex(value: string, fallback: string) {
  const normalized = value.replace("#", "").slice(0, 6).toUpperCase();
  return /^[0-9A-F]{6}$/u.test(normalized) ? normalized : fallback;
}

function boardBounds(aspectRatio: number) {
  const safeAspect = clamp(aspectRatio || 1.6, 0.45, 3.2);
  const availableWidth = SLIDE_WIDTH - OUTER_MARGIN * 2;
  const availableHeight = SLIDE_HEIGHT - OUTER_MARGIN * 2;
  const availableAspect = availableWidth / availableHeight;
  const width = safeAspect >= availableAspect ? availableWidth : availableHeight * safeAspect;
  const height = safeAspect >= availableAspect ? availableWidth / safeAspect : availableHeight;
  return { x: (SLIDE_WIDTH - width) / 2, y: (SLIDE_HEIGHT - height) / 2, width, height };
}

function noteCenter(note: PowerPointNote, bounds: ReturnType<typeof boardBounds>) {
  return {
    x: bounds.x + (note.x + note.width / 2) / 100 * bounds.width,
    y: bounds.y + (note.y + note.height / 2) / 100 * bounds.height,
  };
}

function noteFontSize(note: PowerPointNote, width: number, height: number) {
  const characters = Math.max(4, note.text.trim().length);
  const areaFit = Math.sqrt(Math.max(0.02, width * height) / characters) * 34;
  return clamp(Math.round(Math.min(areaFit, height * 22) * 10) / 10, 8, 22);
}

/** Builds a standards-compliant PPTX with native, editable PowerPoint objects. */
export function createBoardPresentation(board: PowerPointBoard) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Sticky Note Lab";
  pptx.company = "Sticky Note Lab";
  pptx.subject = "Editable sticky note board";
  pptx.title = board.title?.trim() || "Sticky Note Lab Board";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  const slide = pptx.addSlide();
  slide.background = { color: "ECE9E1" };
  const bounds = boardBounds(board.aspectRatio);
  slide.addShape(pptx.ShapeType.rect, {
    x: bounds.x,
    y: bounds.y,
    w: bounds.width,
    h: bounds.height,
    fill: { color: "F7F4EC" },
    line: { color: "D5D1C6", width: 0.8 },
    shadow: { type: "outer", color: "292923", opacity: 0.14, blur: 4, angle: 45, offset: 2 },
    objectName: "Sticky Note Board",
  });

  const byId = new Map(board.notes.map((note) => [note.id, note]));
  // Connections are inserted before notes so every arrow stays behind the
  // editable paper shapes in PowerPoint's z-order.
  board.edges.forEach((edge, index) => {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    if (!source || !target) return;
    const start = noteCenter(source, bounds);
    const end = noteCenter(target, bounds);
    slide.addShape(pptx.ShapeType.line, {
      x: start.x,
      y: start.y,
      w: end.x - start.x,
      h: end.y - start.y,
      line: { color: "56544D", width: 1.4, transparency: 18, endArrowType: "triangle" },
      objectName: `Connection ${index + 1}`,
    });
  });

  [...board.notes]
    .sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0))
    .forEach((note, index) => {
      const x = bounds.x + note.x / 100 * bounds.width;
      const y = bounds.y + note.y / 100 * bounds.height;
      const width = Math.max(0.08, note.width / 100 * bounds.width);
      const height = Math.max(0.08, note.height / 100 * bounds.height);
      slide.addText(note.text || "", {
        shape: pptx.ShapeType.rect,
        x,
        y,
        w: width,
        h: height,
        rotate: clamp(note.rotation ?? 0, -360, 360),
        fill: { color: cleanHex(note.color, "F7DC68") },
        line: { color: "514A3D", width: 0.55, transparency: 72 },
        shadow: { type: "outer", color: "292923", opacity: 0.18, blur: 2, angle: 45, offset: 1.2 },
        color: "292923",
        fontFace: "Aptos",
        lang: "de-DE",
        fontSize: noteFontSize(note, width, height),
        bold: true,
        margin: [7, 7, 6, 7],
        valign: "top",
        breakLine: false,
        fit: "shrink",
        objectName: `Sticky Note ${index + 1}`,
      });
    });

  slide.addNotes("Generated locally in the browser by Sticky Note Lab. Every sticky note is a native editable PowerPoint text shape.");
  return pptx;
}

export async function exportBoardToPowerPoint(board: PowerPointBoard, fileName = "sticky-note-lab-board.pptx") {
  const pptx = createBoardPresentation(board);
  await pptx.writeFile({ fileName, compression: true });
}

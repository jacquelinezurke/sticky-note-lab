"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Focus,
  GripVertical,
  ImagePlus,
  Link2,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  ScanLine,
  Sparkles,
  Trash2,
  Undo2,
  Unlink,
  Upload,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Note = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
  confidence: number;
};

type Edge = { id: string; sourceId: string; targetId: string };
type Snapshot = { notes: Note[]; edges: Edge[] };
type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  original: Note;
} | null;

const DEMO_NOTES: Note[] = [
  { id: "note-1", x: 8, y: 12, width: 21, height: 20, color: "#f7dc68", text: "Was brauchen unsere Nutzer wirklich?", confidence: 96 },
  { id: "note-2", x: 38, y: 9, width: 20, height: 18, color: "#f2a3b4", text: "Weniger Schritte bis zum Ergebnis", confidence: 91 },
  { id: "note-3", x: 68, y: 14, width: 21, height: 21, color: "#a9d9ee", text: "Feedback früh einholen", confidence: 87 },
  { id: "note-4", x: 14, y: 51, width: 21, height: 19, color: "#b9dfa5", text: "Prototyp diese Woche", confidence: 94 },
  { id: "note-5", x: 45, y: 48, width: 22, height: 21, color: "#f7dc68", text: "Mit echten Fotos testen", confidence: 83 },
  { id: "note-6", x: 72, y: 57, width: 19, height: 18, color: "#cdb8ee", text: "Erkenntnisse teilen", confidence: 98 },
];

const DEMO_EDGES: Edge[] = [
  { id: "edge-1", sourceId: "note-1", targetId: "note-2" },
  { id: "edge-2", sourceId: "note-2", targetId: "note-3" },
  { id: "edge-3", sourceId: "note-4", targetId: "note-5" },
];

const PALETTE = ["#f7dc68", "#f2a3b4", "#a9d9ee", "#b9dfa5", "#cdb8ee", "#f2b46d", "#f6f0df", "#d6d8db"];
const MIN_NOTE_SIZE = 9;

function cloneSnapshot(notes: Note[], edges: Edge[]): Snapshot {
  return { notes: notes.map((note) => ({ ...note })), edges: edges.map((edge) => ({ ...edge })) };
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function nearestPalette(rgb: [number, number, number]) {
  return PALETTE.reduce((best, color) => {
    const distance = colorDistance(rgb, hexToRgb(color));
    return distance < best.distance ? { color, distance } : best;
  }, { color: PALETTE[0], distance: Number.POSITIVE_INFINITY }).color;
}

function noteCenter(note: Note) {
  return { x: note.x + note.width / 2, y: note.y + note.height / 2 };
}

function makeCurve(source: Note, target: Note) {
  const start = noteCenter(source);
  const end = noteCenter(target);
  const bend = Math.max(5, Math.abs(end.x - start.x) * 0.32);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function downloadBlob(name: string, blob: Blob) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function detectStickyNotes(
  imageSrc: string,
  report: (progress: number, label: string) => void,
): Promise<Note[]> {
  const image = await loadImage(imageSrc);
  const maxSide = 1100;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas konnte nicht initialisiert werden.");
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  report(10, "Farben und Konturen werden untersucht");

  const step = Math.max(2, Math.round(Math.max(width, height) / 420));
  const sampleWidth = Math.ceil(width / step);
  const sampleHeight = Math.ceil(height / step);
  const mask = new Uint8Array(sampleWidth * sampleHeight);
  const pixelIndex = (sx: number, sy: number) => ((sy * step) * width + sx * step) * 4;

  for (let sy = 0; sy < sampleHeight; sy += 1) {
    for (let sx = 0; sx < sampleWidth; sx += 1) {
      const sourceIndex = pixelIndex(sx, sy);
      const r = data[sourceIndex];
      const g = data[sourceIndex + 1];
      const b = data[sourceIndex + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const brightness = max / 255;
      const chroma = max - min;
      mask[sy * sampleWidth + sx] = brightness > 0.48 && saturation > 0.14 && chroma > 24 ? 1 : 0;
    }
  }

  report(25, "Zusammenhängende Flächen werden gesucht");
  const visited = new Uint8Array(mask.length);
  const components: Array<{ minX: number; maxX: number; minY: number; maxY: number; count: number }> = [];
  const queueX = new Int32Array(mask.length);
  const queueY = new Int32Array(mask.length);

  for (let sy = 0; sy < sampleHeight; sy += 1) {
    for (let sx = 0; sx < sampleWidth; sx += 1) {
      const startIndex = sy * sampleWidth + sx;
      if (!mask[startIndex] || visited[startIndex]) continue;
      let head = 0;
      let tail = 0;
      queueX[tail] = sx;
      queueY[tail] = sy;
      tail += 1;
      visited[startIndex] = 1;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let count = 0;
      while (head < tail) {
        const x = queueX[head];
        const y = queueY[head];
        head += 1;
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= sampleWidth || ny >= sampleHeight) continue;
            const nextIndex = ny * sampleWidth + nx;
            if (!mask[nextIndex] || visited[nextIndex]) continue;
            visited[nextIndex] = 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail += 1;
          }
        }
      }
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const boxArea = boxWidth * boxHeight;
      const areaRatio = boxArea / (sampleWidth * sampleHeight);
      const fill = count / boxArea;
      const aspect = boxWidth / boxHeight;
      if (areaRatio > 0.003 && areaRatio < 0.19 && aspect > 0.45 && aspect < 2.1 && fill > 0.32) {
        components.push({ minX, maxX, minY, maxY, count });
      }
    }
  }

  components.sort((a, b) => b.count - a.count);
  const deduped = components.filter((component, index, all) => {
    const cx = (component.minX + component.maxX) / 2;
    const cy = (component.minY + component.maxY) / 2;
    return !all.slice(0, index).some((candidate) => cx >= candidate.minX && cx <= candidate.maxX && cy >= candidate.minY && cy <= candidate.maxY);
  }).slice(0, 36);

  report(35, deduped.length ? `${deduped.length} mögliche Notizen gefunden` : "Keine sicheren Konturen – Beispielobjekte werden angelegt");
  const notes = deduped.map((component, index) => {
    const left = component.minX * step;
    const top = component.minY * step;
    const boxWidth = (component.maxX - component.minX + 1) * step;
    const boxHeight = (component.maxY - component.minY + 1) * step;
    const marginX = Math.max(1, Math.round(boxWidth * 0.18));
    const marginY = Math.max(1, Math.round(boxHeight * 0.18));
    const samples: Array<[number, number, number]> = [];
    const stride = Math.max(1, Math.round(Math.min(boxWidth, boxHeight) / 16));
    for (let y = top + marginY; y < top + boxHeight - marginY; y += stride) {
      for (let x = left + marginX; x < left + boxWidth - marginX; x += stride) {
        const sourceIndex = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4;
        const rgb: [number, number, number] = [data[sourceIndex], data[sourceIndex + 1], data[sourceIndex + 2]];
        if (Math.max(...rgb) > 70) samples.push(rgb);
      }
    }
    samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    const median = samples[Math.floor(samples.length * 0.68)] ?? [247, 220, 104];
    return {
      id: `scan-${index + 1}-${Date.now().toString(36)}`,
      x: clamp((left / width) * 100, 0, 94),
      y: clamp((top / height) * 100, 0, 90),
      width: clamp((boxWidth / width) * 100, MIN_NOTE_SIZE, 32),
      height: clamp((boxHeight / height) * 100, MIN_NOTE_SIZE, 31),
      color: nearestPalette(median),
      text: "",
      confidence: 0,
    };
  });

  if (notes.length === 0) {
    return DEMO_NOTES.slice(0, 4).map((note, index) => ({
      ...note,
      id: `manual-${index + 1}-${Date.now().toString(36)}`,
      text: "Text ergänzen",
      confidence: 0,
    }));
  }

  report(40, "Texterkennung wird vorbereitet");
  try {
    const { createWorker, OEM, PSM } = await import("tesseract.js");
    let activeNote = 0;
    const worker = await createWorker(["deu", "eng"], OEM.LSTM_ONLY, {
      logger: (message) => {
        if (message.status === "recognizing text") {
          const overall = 40 + ((activeNote + message.progress) / Math.max(1, notes.length)) * 55;
          report(Math.round(overall), `Text ${activeNote + 1} von ${notes.length}`);
        }
      },
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
    for (activeNote = 0; activeNote < notes.length; activeNote += 1) {
      const note = notes[activeNote];
      const crop = document.createElement("canvas");
      crop.width = Math.max(160, Math.round((note.width / 100) * width * 2));
      crop.height = Math.max(130, Math.round((note.height / 100) * height * 2));
      const cropContext = crop.getContext("2d");
      if (!cropContext) continue;
      cropContext.fillStyle = "white";
      cropContext.fillRect(0, 0, crop.width, crop.height);
      cropContext.drawImage(
        canvas,
        (note.x / 100) * width,
        (note.y / 100) * height,
        (note.width / 100) * width,
        (note.height / 100) * height,
        0,
        0,
        crop.width,
        crop.height,
      );
      const result = await worker.recognize(crop, {}, { text: true, blocks: true });
      note.text = result.data.text.trim().replace(/\n{3,}/g, "\n\n") || "Text ergänzen";
      note.confidence = Math.round(result.data.confidence || 0);
    }
    await worker.terminate();
  } catch (error) {
    console.warn("OCR nicht verfügbar", error);
    notes.forEach((note) => {
      note.text = "Text ergänzen";
      note.confidence = 0;
    });
  }

  report(100, "Board ist bereit");
  return notes;
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>(DEMO_NOTES);
  const [edges, setEdges] = useState<Edge[]>(DEMO_EDGES);
  const [selectedId, setSelectedId] = useState<string | null>("note-2");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "connect">("select");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [showPhoto, setShowPhoto] = useState(true);
  const [photoOpacity, setPhotoOpacity] = useState(24);
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState("Beispielboard bereit");
  const [analysisProgress, setAnalysisProgress] = useState(100);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [dragState, setDragState] = useState<DragState>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef(notes);
  const edgesRef = useRef(edges);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
  const confidenceAverage = notes.length ? Math.round(notes.reduce((sum, note) => sum + note.confidence, 0) / notes.length) : 0;
  const lowConfidenceCount = notes.filter((note) => note.confidence < 70).length;

  const pushHistory = useCallback(() => {
    setHistory((current) => [...current.slice(-39), cloneSnapshot(notesRef.current, edgesRef.current)]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current[current.length - 1];
      if (!previous) return current;
      setFuture((next) => [cloneSnapshot(notesRef.current, edgesRef.current), ...next]);
      setNotes(previous.notes);
      setEdges(previous.edges);
      setSelectedId(null);
      return current.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((current) => {
      const next = current[0];
      if (!next) return current;
      setHistory((previous) => [...previous, cloneSnapshot(notesRef.current, edgesRef.current)]);
      setNotes(next.notes);
      setEdges(next.edges);
      setSelectedId(null);
      return current.slice(1);
    });
  }, []);

  const updateNote = useCallback((id: string, patch: Partial<Note>, saveHistory = true) => {
    if (saveHistory) pushHistory();
    setNotes((current) => current.map((note) => note.id === id ? { ...note, ...patch } : note));
  }, [pushHistory]);

  const addNote = useCallback(() => {
    pushHistory();
    const id = uid("note");
    setNotes((current) => [...current, {
      id,
      x: 37 + Math.random() * 8,
      y: 32 + Math.random() * 8,
      width: 20,
      height: 19,
      color: PALETTE[current.length % PALETTE.length],
      text: "Neue Idee",
      confidence: 100,
    }]);
    setSelectedId(id);
    setTool("select");
  }, [pushHistory]);

  const deleteSelection = useCallback(() => {
    if (!selectedId && !selectedEdgeId) return;
    pushHistory();
    if (selectedId) {
      setNotes((current) => current.filter((note) => note.id !== selectedId));
      setEdges((current) => current.filter((edge) => edge.sourceId !== selectedId && edge.targetId !== selectedId));
      setSelectedId(null);
    }
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }, [pushHistory, selectedEdgeId, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isEditing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
      if (!isEditing && (event.key === "Delete" || event.key === "Backspace")) deleteSelection();
      if (event.key === "Escape") {
        setConnectingFrom(null);
        setTool("select");
        setSelectedEdgeId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection, redo, undo]);

  const handleNoteClick = (event: ReactMouseEvent, note: Note) => {
    event.stopPropagation();
    if (tool === "connect") {
      if (!connectingFrom) {
        setConnectingFrom(note.id);
        setToast("Jetzt die Zielnotiz anklicken");
      } else if (connectingFrom === note.id) {
        setConnectingFrom(null);
      } else {
        const alreadyExists = edges.some((edge) => edge.sourceId === connectingFrom && edge.targetId === note.id);
        if (!alreadyExists) {
          pushHistory();
          setEdges((current) => [...current, { id: uid("edge"), sourceId: connectingFrom, targetId: note.id }]);
        }
        setConnectingFrom(null);
        setTool("select");
        setToast("Verbindung angelegt");
      }
      return;
    }
    setSelectedId(note.id);
    setSelectedEdgeId(null);
  };

  const startPointerAction = (event: ReactPointerEvent, note: Note, mode: "move" | "resize") => {
    if (tool !== "select" || (event.target as HTMLElement).closest("textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    pushHistory();
    setSelectedId(note.id);
    setSelectedEdgeId(null);
    setDragState({ id: note.id, mode, startX: event.clientX, startY: event.clientY, original: { ...note } });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const movePointerAction = (event: ReactPointerEvent) => {
    if (!dragState || !boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const dx = ((event.clientX - dragState.startX) / rect.width) * 100;
    const dy = ((event.clientY - dragState.startY) / rect.height) * 100;
    const original = dragState.original;
    if (dragState.mode === "move") {
      setNotes((current) => current.map((note) => note.id === dragState.id ? {
        ...note,
        x: clamp(original.x + dx, 0, 100 - note.width),
        y: clamp(original.y + dy, 0, 100 - note.height),
      } : note));
    } else {
      setNotes((current) => current.map((note) => note.id === dragState.id ? {
        ...note,
        width: clamp(original.width + dx, MIN_NOTE_SIZE, 100 - original.x),
        height: clamp(original.height + dy, MIN_NOTE_SIZE, 100 - original.y),
      } : note));
    }
  };

  const analyzeFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setToast("Bitte ein JPG-, PNG- oder WebP-Bild wählen");
      return;
    }
    if (file.size > 24 * 1024 * 1024) {
      setToast("Das Bild ist größer als 24 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const src = String(reader.result);
      setImageSrc(src);
      setFileName(file.name);
      setShowPhoto(true);
      setIsAnalyzing(true);
      setAnalysisProgress(2);
      setStatus("Foto wird vorbereitet");
      try {
        const detected = await detectStickyNotes(src, (progress, label) => {
          setAnalysisProgress(progress);
          setStatus(label);
        });
        pushHistory();
        setNotes(detected);
        setEdges([]);
        setSelectedId(detected[0]?.id ?? null);
        setSelectedEdgeId(null);
        setToast(`${detected.length} Notizen angelegt`);
      } catch (error) {
        console.error(error);
        setStatus("Analyse fehlgeschlagen – du kannst Notizen manuell anlegen");
        setToast("Analyse fehlgeschlagen");
      } finally {
        setIsAnalyzing(false);
        setAnalysisProgress(100);
      }
    };
    reader.readAsDataURL(file);
  }, [pushHistory]);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void analyzeFile(file);
    event.target.value = "";
  };

  const exportJson = () => {
    const payload = {
      format: "postit-lab-board",
      version: 1,
      createdAt: new Date().toISOString(),
      source: { fileName, photoIncluded: false },
      notes,
      edges,
    };
    downloadBlob("postit-lab-board.json", new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    setToast("Board als JSON exportiert");
  };

  const importJson = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result));
        if (payload?.format !== "postit-lab-board" || !Array.isArray(payload.notes) || !Array.isArray(payload.edges)) throw new Error("Unbekanntes Format");
        pushHistory();
        setNotes(payload.notes);
        setEdges(payload.edges);
        setSelectedId(payload.notes[0]?.id ?? null);
        setStatus("Importiertes Board bereit");
        setToast("Board importiert");
      } catch {
        setToast("Dieses JSON ist kein gültiges Post-it-Lab-Board");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const exportPng = () => {
    const width = 1600;
    const height = 1000;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f5f1e8";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(44, 42, 36, .06)";
    for (let x = 0; x < width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    for (const edge of edges) {
      const source = notes.find((note) => note.id === edge.sourceId);
      const target = notes.find((note) => note.id === edge.targetId);
      if (!source || !target) continue;
      const a = noteCenter(source);
      const b = noteCenter(target);
      ctx.strokeStyle = "#4a4944";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo((a.x / 100) * width, (a.y / 100) * height);
      ctx.lineTo((b.x / 100) * width, (b.y / 100) * height);
      ctx.stroke();
    }
    for (const note of notes) {
      const x = (note.x / 100) * width;
      const y = (note.y / 100) * height;
      const w = (note.width / 100) * width;
      const h = (note.height / 100) * height;
      ctx.fillStyle = "rgba(53, 45, 26, .15)";
      ctx.fillRect(x + 8, y + 10, w, h);
      ctx.fillStyle = note.color;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#24241f";
      ctx.font = "600 26px Arial";
      const words = note.text.split(/\s+/);
      let line = "";
      let lineY = y + 45;
      for (const word of words) {
        const test = `${line}${word} `;
        if (ctx.measureText(test).width > w - 42 && line) {
          ctx.fillText(line.trim(), x + 22, lineY);
          line = `${word} `;
          lineY += 34;
        } else line = test;
      }
      ctx.fillText(line.trim(), x + 22, lineY);
    }
    canvas.toBlob((blob) => { if (blob) downloadBlob("postit-lab-board.png", blob); }, "image/png");
    setToast("Board als PNG exportiert");
  };

  const resetDemo = () => {
    pushHistory();
    setNotes(DEMO_NOTES.map((note) => ({ ...note })));
    setEdges(DEMO_EDGES.map((edge) => ({ ...edge })));
    setImageSrc(null);
    setFileName("");
    setStatus("Beispielboard bereit");
    setSelectedId("note-2");
  };

  const edgeElements = useMemo(() => edges.map((edge) => {
    const source = notes.find((note) => note.id === edge.sourceId);
    const target = notes.find((note) => note.id === edge.targetId);
    if (!source || !target) return null;
    return (
      <path
        key={edge.id}
        d={makeCurve(source, target)}
        className={selectedEdgeId === edge.id ? "edge selected" : "edge"}
        markerEnd="url(#arrowhead)"
        onClick={(event) => {
          event.stopPropagation();
          setSelectedEdgeId(edge.id);
          setSelectedId(null);
        }}
      />
    );
  }), [edges, notes, selectedEdgeId]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><h1>Post-it Lab</h1><p>Vom Foto zum editierbaren Board</p></div>
        </div>
        <div className="project-name"><span className="status-dot" /><strong>{fileName || "Workshop-Experiment"}</strong><ChevronDown size={15} /></div>
        <div className="header-actions">
          <button className="icon-button" aria-label="Rückgängig" title="Rückgängig" disabled={!history.length} onClick={undo}><Undo2 size={18} /></button>
          <button className="icon-button" aria-label="Wiederholen" title="Wiederholen" disabled={!future.length} onClick={redo}><Redo2 size={18} /></button>
          <div className="export-menu">
            <button className="primary-button" onClick={exportJson}><Download size={16} /> Exportieren <ChevronDown size={14} /></button>
            <div className="export-popover">
              <button onClick={exportJson}><FileJson size={16} /> Board-JSON</button>
              <button onClick={exportPng}><ImagePlus size={16} /> PNG-Bild</button>
              <button onClick={() => importInputRef.current?.click()}><Upload size={16} /> JSON importieren</button>
            </div>
          </div>
          <button className="avatar" aria-label="Lokales Profil">DU</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">QUELLE</span><h2>Board-Foto</h2></div>
            <CircleHelp size={17} />
          </div>
          <button
            className={`drop-zone ${isDraggingOver ? "dragging" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setIsDraggingOver(true); }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDraggingOver(false);
              const file = event.dataTransfer.files[0];
              if (file) void analyzeFile(file);
            }}
          >
            <div className="upload-icon"><ImagePlus size={25} /></div>
            <strong>{imageSrc ? "Anderes Foto wählen" : "Foto hier ablegen"}</strong>
            <span>oder klicken · JPG, PNG, WebP</span>
          </button>

          {imageSrc ? (
            <div className="source-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageSrc} alt="Hochgeladenes Post-it-Board" />
              <button className="preview-remove" onClick={() => { setImageSrc(null); setFileName(""); }} aria-label="Foto entfernen"><X size={15} /></button>
              <div className="preview-name"><Check size={15} /> <span>{fileName}</span></div>
            </div>
          ) : (
            <div className="capture-tips"><Sparkles size={17} /><div><strong>Für gute Ergebnisse</strong><p>Gerade fotografieren, Reflexionen vermeiden und möglichst nah ans Board gehen.</p></div></div>
          )}

          <div className="analysis-card">
            <div className="analysis-title">
              <span className={isAnalyzing ? "analyzing-badge pulse" : "analyzing-badge"}>
                {isAnalyzing ? <LoaderCircle size={14} /> : <ScanLine size={14} />}{isAnalyzing ? "ANALYSE" : "BEREIT"}
              </span>
              <span>{analysisProgress}%</span>
            </div>
            <div className="progress-track"><span style={{ width: `${analysisProgress}%` }} /></div>
            <p>{status}</p>
          </div>

          <div className="layer-section">
            <div className="section-label"><span>EBENEN</span><Plus size={15} /></div>
            <button className="layer-row active" onClick={() => setShowPhoto((value) => !value)}>
              <span className="layer-thumb"><ImagePlus size={15} /></span>
              <span><strong>Originalfoto</strong><small>gesperrter Hintergrund</small></span>
              {showPhoto ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <button className="layer-row">
              <span className="layer-thumb notes"><GripVertical size={15} /></span>
              <span><strong>Digitale Notizen</strong><small>{notes.length} Objekte</small></span>
              <Eye size={16} />
            </button>
            <label className="opacity-control">
              <span>Foto-Deckkraft</span><strong>{photoOpacity}%</strong>
              <input type="range" min="0" max="90" value={photoOpacity} onChange={(event) => setPhotoOpacity(Number(event.target.value))} />
            </label>
          </div>
          <button className="secondary-button full" onClick={resetDemo}><RotateCcw size={16} /> Beispiel zurücksetzen</button>
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div className="tool-group">
              <button className={tool === "select" ? "tool active" : "tool"} onClick={() => { setTool("select"); setConnectingFrom(null); }} title="Auswählen"><MousePointer2 size={18} /></button>
              <button className="tool" onClick={addNote} title="Notiz hinzufügen"><Plus size={19} /></button>
              <button className={tool === "connect" ? "tool active" : "tool"} onClick={() => { setTool("connect"); setConnectingFrom(null); }} title="Verbinden"><Link2 size={18} /></button>
              <span className="tool-separator" />
              <button className="tool" onClick={() => setShowPhoto((value) => !value)} title="Foto ein-/ausblenden">{showPhoto ? <Eye size={18} /> : <EyeOff size={18} />}</button>
              <button className="tool" onClick={() => setZoom(100)} title="Ansicht zentrieren"><Focus size={18} /></button>
            </div>
            <div className="canvas-summary">
              <span><i className="mini-dot yellow" /> {notes.length} Notizen</span>
              <span><Link2 size={13} /> {edges.length} Verbindungen</span>
              {lowConfidenceCount > 0 && <span className="warning-summary">{lowConfidenceCount} prüfen</span>}
            </div>
          </div>

          <div className="canvas-viewport">
            <div
              ref={boardRef}
              className={`board ${tool === "connect" ? "connecting" : ""}`}
              style={{ transform: `scale(${zoom / 100})` }}
            >
              {imageSrc && showPhoto && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="board-photo" src={imageSrc} alt="" style={{ opacity: photoOpacity / 100 }} />
              )}
              <svg className="edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Verbindungen">
                <defs><marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L6,3 z" fill="currentColor" /></marker></defs>
                {edgeElements}
              </svg>
              {notes.map((note, index) => (
                <div
                  key={note.id}
                  role="button"
                  tabIndex={0}
                  className={`sticky-note ${selectedId === note.id ? "selected" : ""} ${connectingFrom === note.id ? "connect-source" : ""} ${note.confidence < 70 ? "low-confidence" : ""}`}
                  style={{ left: `${note.x}%`, top: `${note.y}%`, width: `${note.width}%`, height: `${note.height}%`, background: note.color, zIndex: selectedId === note.id ? 8 : 2 + index }}
                  onClick={(event) => handleNoteClick(event, note)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleNoteClick(event as unknown as ReactMouseEvent, note);
                    }
                  }}
                  onPointerDown={(event) => startPointerAction(event, note, "move")}
                  onPointerMove={movePointerAction}
                  onPointerUp={() => setDragState(null)}
                  onPointerCancel={() => setDragState(null)}
                >
                  <div className="note-tape" />
                  {note.confidence < 70 && <span className="confidence-flag" title="Text bitte prüfen">?</span>}
                  <textarea
                    value={note.text}
                    aria-label="Notiztext"
                    spellCheck
                    onPointerDown={(event) => event.stopPropagation()}
                    onFocus={() => { pushHistory(); setSelectedId(note.id); setSelectedEdgeId(null); }}
                    onChange={(event) => setNotes((current) => current.map((item) => item.id === note.id ? { ...item, text: event.target.value, confidence: 100 } : item))}
                  />
                  {selectedId === note.id && tool === "select" && (
                    <button
                      className="resize-handle"
                      aria-label="Notizgröße ändern"
                      onPointerDown={(event) => startPointerAction(event, note, "resize")}
                      onPointerMove={movePointerAction}
                      onPointerUp={() => setDragState(null)}
                    ><Maximize2 size={12} /></button>
                  )}
                </div>
              ))}
              {isAnalyzing && (
                <div className="analysis-overlay">
                  <div className="scanner-line" />
                  <div className="analysis-modal"><WandSparkles size={24} /><strong>{status}</strong><span>{analysisProgress}%</span></div>
                </div>
              )}
            </div>
            <div className="zoom-control">
              <button onClick={() => setZoom((value) => clamp(value - 10, 60, 150))}><ZoomOut size={16} /></button>
              <button className="zoom-value" onClick={() => setZoom(100)}>{zoom}%</button>
              <button onClick={() => setZoom((value) => clamp(value + 10, 60, 150))}><ZoomIn size={16} /></button>
            </div>
            <div className="privacy-pill"><span /> Verarbeitung lokal im Browser</div>
          </div>
        </section>

        <aside className="right-panel panel">
          <div className="panel-heading inspector-title">
            <div><span className="eyebrow">INSPEKTOR</span><h2>{selectedNote ? "Notiz bearbeiten" : selectedEdgeId ? "Verbindung" : "Board"}</h2></div>
            {selectedNote && <span className="object-index">#{notes.findIndex((note) => note.id === selectedNote.id) + 1}</span>}
          </div>

          {selectedNote ? (
            <div className="inspector-content">
              <label className="field-label" htmlFor="note-text">TEXT</label>
              <textarea id="note-text" className="inspector-textarea" value={selectedNote.text} onFocus={pushHistory} onChange={(event) => updateNote(selectedNote.id, { text: event.target.value, confidence: 100 }, false)} />
              <div className="confidence-row"><span>Erkennung</span><span className={selectedNote.confidence < 70 ? "confidence weak" : "confidence"}>{selectedNote.confidence || 0}%</span></div>
              <div className="field-label">FARBE</div>
              <div className="palette" role="group" aria-label="Notizfarbe">
                {PALETTE.map((color) => (
                  <button key={color} className={selectedNote.color === color ? "swatch selected" : "swatch"} style={{ background: color }} aria-label={`Farbe ${color}`} onClick={() => updateNote(selectedNote.id, { color })}>{selectedNote.color === color && <Check size={15} />}</button>
                ))}
              </div>
              <div className="field-label">POSITION & GRÖSSE</div>
              <div className="number-grid">
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <label key={field}>
                    <span>{field === "width" ? "B" : field === "height" ? "H" : field.toUpperCase()}</span>
                    <input type="number" value={Math.round(selectedNote[field] * 10) / 10} min="0" max="100" step="0.5" onFocus={pushHistory} onChange={(event) => updateNote(selectedNote.id, { [field]: Number(event.target.value) }, false)} />
                    <small>%</small>
                  </label>
                ))}
              </div>
              <button className="secondary-button full connection-button" onClick={() => { setTool("connect"); setConnectingFrom(selectedNote.id); }}><Link2 size={16} /> Von hier verbinden</button>
              <button className="danger-button full" onClick={deleteSelection}><Trash2 size={16} /> Notiz löschen</button>
            </div>
          ) : selectedEdgeId ? (
            <div className="empty-inspector">
              <div className="empty-icon"><ArrowRight size={22} /></div><h3>Verbindung ausgewählt</h3>
              <p>Die Verbindung bleibt an beiden Notizen befestigt, wenn du sie verschiebst.</p>
              <button className="danger-button full" onClick={deleteSelection}><Unlink size={16} /> Verbindung löschen</button>
            </div>
          ) : (
            <div className="empty-inspector">
              <div className="empty-icon"><MousePointer2 size={22} /></div><h3>Wähle eine Notiz</h3>
              <p>Dann kannst du Text, Farbe, Position und Größe direkt anpassen.</p>
              <div className="board-stats"><span><strong>{notes.length}</strong> Notizen</span><span><strong>{edges.length}</strong> Verbindungen</span><span><strong>{confidenceAverage}%</strong> OCR Ø</span></div>
            </div>
          )}

          <div className="local-card"><div className="local-icon"><Check size={16} /></div><div><strong>Dein Foto bleibt hier</strong><p>Kein Upload, kein Account. Das Experiment läuft auf deinem Gerät.</p></div></div>
        </aside>
      </section>

      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFileInput} />
      <input ref={importInputRef} type="file" accept="application/json" hidden onChange={importJson} />
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </main>
  );
}

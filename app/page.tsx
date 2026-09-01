"use client";

import {
  ArrowRight, Check, ChevronDown, CircleHelp, Download, Eye, EyeOff, FileJson,
  FileSpreadsheet, Focus, GripVertical, ImagePlus, Link2, LoaderCircle, Maximize2, MousePointer2,
  Plus, Presentation, Redo2, RotateCcw, ScanLine, Sparkles, Trash2, Undo2, Unlink, Upload,
  WandSparkles, X, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  type ChangeEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { recognizeNoteTexts, type OcrRunDiagnostics } from "./ocr-engine";
import { estimateQuadrilateralFromMask, type OcrQuad } from "./ocr-preprocessing";
import { detectStickyGeometryFromRgba } from "./sticky-detection";
import {
  estimateNoteLab,
  nearestStickyPalette,
  STICKY_NOTE_PALETTE,
  type ColorQuad,
} from "./note-color";
import {
  createTidyLayout,
  inferOverlapLayerOrder,
  quadToBoardGeometry,
  type BoardQuad,
} from "./board-layout";
import {
  appendManualSymbol,
  SIMPLE_SYMBOL_LABELS,
  SIMPLE_SYMBOLS,
  type RecognizedSymbol,
  type SimpleSymbol,
} from "./symbol-recognition";
import type { OcrEvidence, TextCorrection } from "./text-correction";
import { PipelineVisualization } from "./pipeline-visualization";

type Note = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
  confidence: number;
  rotation?: number;
  zIndex?: number;
  origin?: "scan" | "manual" | "demo" | "import";
  rawText?: string;
  rawConfidence?: number;
  corrections?: TextCorrection[];
  symbols?: RecognizedSymbol[];
  ocrEvidence?: OcrEvidence[];
};

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

type Edge = { id: string; sourceId: string; targetId: string };
type LayoutMode = "original" | "tidy";
type Snapshot = { notes: Note[]; edges: Edge[] };
type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  original: Note;
} | null;

const DEMO_NOTES: Note[] = [
  { id: "note-1", x: 8, y: 12, width: 21, height: 20, rotation: -1.2, zIndex: 2, origin: "demo", color: "#f7dc68", text: "Was brauchen unsere Nutzer wirklich?", confidence: 96 },
  { id: "note-2", x: 38, y: 9, width: 20, height: 18, rotation: 0.8, zIndex: 3, origin: "demo", color: "#f2a3b4", text: "Weniger Schritte bis zum Ergebnis", confidence: 91 },
  { id: "note-3", x: 68, y: 14, width: 21, height: 21, rotation: -0.5, zIndex: 4, origin: "demo", color: "#a9d9ee", text: "Feedback früh einholen", confidence: 87 },
  { id: "note-4", x: 14, y: 51, width: 21, height: 19, rotation: 0.6, zIndex: 5, origin: "demo", color: "#b9dfa5", text: "Prototyp diese Woche", confidence: 94 },
  { id: "note-5", x: 45, y: 48, width: 22, height: 21, rotation: -0.7, zIndex: 6, origin: "demo", color: "#f7dc68", text: "Mit echten Fotos testen", confidence: 83 },
  { id: "note-6", x: 72, y: 57, width: 19, height: 18, rotation: 1.1, zIndex: 7, origin: "demo", color: "#cdb8ee", text: "Erkenntnisse teilen", confidence: 98 },
];

const DEMO_EDGES: Edge[] = [
  { id: "edge-1", sourceId: "note-1", targetId: "note-2" },
  { id: "edge-2", sourceId: "note-2", targetId: "note-3" },
  { id: "edge-3", sourceId: "note-4", targetId: "note-5" },
];

const PALETTE = [...STICKY_NOTE_PALETTE];
const MIN_RESIZE_SIZE = 4;
const BOARD_EXPORT_FORMAT = "sticky-note-lab-board";
const LEGACY_BOARD_EXPORT_FORMAT = "postit-lab-board";

function cloneSnapshot(notes: Note[], edges: Edge[]): Snapshot {
  return { notes: notes.map((note) => ({ ...note })), edges: edges.map((edge) => ({ ...edge })) };
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
  onGeometry?: (result: { notes: Note[]; aspectRatio: number }) => void,
): Promise<{ notes: Note[]; aspectRatio: number; diagnostics?: OcrRunDiagnostics; symbolCount: number }> {
  const image = await loadImage(imageSrc);
  const maxSide = 1500;
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
  report(10, "Farben werden im Lab-Farbraum gruppiert");

  report(18, "Farbflächen werden geglättet");
  report(23, "Verdeckte Kanten und Überlappungen werden geprüft");
  const geometryDetection = detectStickyGeometryFromRgba(data, width, height);
  const { step, sampleWidth, sampleHeight, labels, notes: accepted } = geometryDetection;
  const measured = accepted.map((component) => ({
    component,
    sampleQuad: (component.corners ?? estimateQuadrilateralFromMask(labels, sampleWidth, sampleHeight, component)) as BoardQuad,
  }));
  const layerOrder = inferOverlapLayerOrder(
    measured.map(({ component, sampleQuad }) => ({ cluster: component.cluster, corners: sampleQuad })),
    labels,
    sampleWidth,
    sampleHeight,
  );

  // Read colour from source-photo crops rather than from the reduced geometry
  // preview. A reusable canvas keeps peak memory bounded for large phone photos.
  const colorCanvas = document.createElement("canvas");
  const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
  const estimateSourceColor = (sourceQuad: BoardQuad, seedLab: [number, number, number]) => {
    if (!colorContext) return nearestStickyPalette(seedLab);
    const originalQuad = sourceQuad.map((point) => ({
      x: point.x * image.naturalWidth / width,
      y: point.y * image.naturalHeight / height,
    })) as ColorQuad;
    const minX = clamp(Math.floor(Math.min(...originalQuad.map((point) => point.x))), 0, image.naturalWidth - 1);
    const minY = clamp(Math.floor(Math.min(...originalQuad.map((point) => point.y))), 0, image.naturalHeight - 1);
    const maxX = clamp(Math.ceil(Math.max(...originalQuad.map((point) => point.x))), minX + 1, image.naturalWidth);
    const maxY = clamp(Math.ceil(Math.max(...originalQuad.map((point) => point.y))), minY + 1, image.naturalHeight);
    const cropWidth = maxX - minX;
    const cropHeight = maxY - minY;
    const cropScale = Math.min(1, 720 / Math.max(cropWidth, cropHeight));
    colorCanvas.width = Math.max(1, Math.round(cropWidth * cropScale));
    colorCanvas.height = Math.max(1, Math.round(cropHeight * cropScale));
    colorContext.drawImage(image, minX, minY, cropWidth, cropHeight, 0, 0, colorCanvas.width, colorCanvas.height);
    const crop = colorContext.getImageData(0, 0, colorCanvas.width, colorCanvas.height);
    const localQuad = originalQuad.map((point) => ({
      x: (point.x - minX) * cropScale,
      y: (point.y - minY) * cropScale,
    })) as ColorQuad;
    return nearestStickyPalette(estimateNoteLab(crop.data, crop.width, crop.height, localQuad, seedLab));
  };

  report(35, accepted.length ? `${accepted.length} sichere Notizen vermessen` : "Keine sicheren Notizen gefunden");
  const detected = measured.map(({ component, sampleQuad }, index) => {
    const sourceQuad = sampleQuad.map((point) => ({
      x: (point.x + 0.5) * step,
      y: (point.y + 0.5) * step,
    })) as BoardQuad;
    const placement = quadToBoardGeometry(sourceQuad, width, height);
    const corners = sampleQuad.map((point) => ({
      x: clamp((((point.x + 0.5) * step) / width) * 100, 0, 100),
      y: clamp((((point.y + 0.5) * step) / height) * 100, 0, 100),
    })) as OcrQuad;
    const note: Note = {
      id: `scan-${index + 1}-${Date.now().toString(36)}`,
      ...placement,
      zIndex: layerOrder[index] + 2,
      origin: "scan",
      color: estimateSourceColor(sourceQuad, geometryDetection.centroids[component.cluster]),
      text: "",
      confidence: 0,
    };
    return { note, corners };
  });
  const notes = detected.map((entry) => entry.note);

  const geometry = { notes: notes.map((note) => ({ ...note })), aspectRatio: image.naturalWidth / image.naturalHeight };
  onGeometry?.(geometry);
  if (!notes.length) return { ...geometry, symbolCount: 0 };

  report(40, "Texterkennung wird vorbereitet");
  let diagnostics: OcrRunDiagnostics | undefined;
  let symbolCount = 0;
  try {
    const recognized = await recognizeNoteTexts(image, detected.map(({ note, corners }) => ({ ...note, corners })), report);
    diagnostics = recognized.diagnostics;
    symbolCount = recognized.symbolCount;
    const byId = new Map(recognized.results.map((result) => [result.id, result]));
    notes.forEach((note) => {
      const result = byId.get(note.id);
      note.text = result?.text ?? "";
      note.confidence = result?.confidence ?? 0;
      note.rawText = result?.rawText ?? note.text;
      note.rawConfidence = result?.rawConfidence ?? note.confidence;
      note.corrections = result?.corrections ?? [];
      note.symbols = result?.symbols ?? [];
      note.ocrEvidence = result?.alternatives ?? [];
    });
  } catch (error) {
    console.warn("OCR nicht verfügbar", error);
    notes.forEach((note) => {
      note.text = "";
      note.confidence = 0;
    });
  }
  if (diagnostics) {
    const active = [
      diagnostics.paddle.status === "ready" || diagnostics.paddle.status === "partial" ? "Paddle" : null,
      diagnostics.dehtr.status === "ready" || diagnostics.dehtr.status === "partial" ? "DE·HTR" : null,
      diagnostics.tesseract.status === "ready" || diagnostics.tesseract.status === "partial" ? "Tesseract" : null,
    ].filter(Boolean).join(" + ");
    const symbolSummary = symbolCount ? ` · ${symbolCount} Symbol${symbolCount === 1 ? "" : "e"}` : "";
    report(100, diagnostics.degraded
      ? `Board fertig – Texterkennung eingeschränkt${active ? ` · ${active}` : ""}${symbolSummary}`
      : `Board ist bereit${active ? ` · ${active}` : ""}${symbolSummary}`);
  } else {
    report(100, "Board fertig – Texterkennung fehlgeschlagen");
  }
  return { notes, aspectRatio: image.naturalWidth / image.naturalHeight, diagnostics, symbolCount };
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
  const [boardAspectRatio, setBoardAspectRatio] = useState(1.6);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("original");
  const [showPhoto, setShowPhoto] = useState(true);
  const [photoOpacity, setPhotoOpacity] = useState(24);
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState("Beispielboard bereit");
  const [analysisProgress, setAnalysisProgress] = useState(100);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [ocrDiagnostics, setOcrDiagnostics] = useState<OcrRunDiagnostics | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [dragState, setDragState] = useState<DragState>(null);
  const [showPipeline, setShowPipeline] = useState(false);
  const [isExportingPowerPoint, setIsExportingPowerPoint] = useState(false);
  const [isExportingSpreadsheet, setIsExportingSpreadsheet] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scanGenerationRef = useRef(0);
  const imageObjectUrlRef = useRef<string | null>(null);
  const notesRef = useRef(notes);
  const edgesRef = useRef(edges);

  const releaseImageObjectUrl = useCallback(() => {
    if (!imageObjectUrlRef.current) return;
    URL.revokeObjectURL(imageObjectUrlRef.current);
    imageObjectUrlRef.current = null;
  }, []);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => () => releaseImageObjectUrl(), [releaseImageObjectUrl]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!isAnalyzing) return;
    const startedAt = Date.now();
    const tick = () => setAnalysisElapsed(Math.floor((Date.now() - startedAt) / 1000));
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isAnalyzing]);

  const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
  const displayNotes = useMemo(
    () => layoutMode === "tidy" ? createTidyLayout(notes, boardAspectRatio) : notes,
    [boardAspectRatio, layoutMode, notes],
  );
  const maximumDisplayLayer = Math.max(2, ...displayNotes.map((note, index) => note.zIndex ?? index + 2));
  const confidenceAverage = notes.length ? Math.round(notes.reduce((sum, note) => sum + note.confidence, 0) / notes.length) : 0;
  const lowConfidenceCount = notes.filter((note) => note.confidence < 70).length;
  const analysisStep = analysisProgress < 10 ? 1 : analysisProgress < 35 ? 2 : analysisProgress < 41 ? 3 : analysisProgress < 85 ? 4 : analysisProgress < 95 ? 5 : 6;
  const isModelStarting = isAnalyzing && analysisProgress === 41;
  const isFallbackRunning = isAnalyzing && analysisProgress >= 95 && analysisProgress < 99;

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

  const insertSymbol = useCallback((symbol: SimpleSymbol) => {
    if (!selectedId) return;
    pushHistory();
    setNotes((current) => current.map((note) => note.id === selectedId ? {
      ...note,
      text: appendManualSymbol(note.text, symbol),
      confidence: 100,
      corrections: [],
    } : note));
  }, [pushHistory, selectedId]);

  const addNote = useCallback(() => {
    pushHistory();
    const id = uid("note");
    setNotes((current) => [...current, {
      id,
      x: 37 + Math.random() * 8,
      y: 32 + Math.random() * 8,
      width: 20,
      height: 19,
      rotation: 0,
      zIndex: Math.max(1, ...current.map((note, index) => note.zIndex ?? index + 2)) + 1,
      origin: "manual",
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
      if (event.key === "Escape") { setConnectingFrom(null); setTool("select"); setSelectedEdgeId(null); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection, redo, undo]);

  const handleNoteClick = (event: ReactMouseEvent, note: Note) => {
    event.stopPropagation();
    if (tool === "connect") {
      if (!connectingFrom) { setConnectingFrom(note.id); setToast("Jetzt die Zielnotiz anklicken"); }
      else if (connectingFrom === note.id) setConnectingFrom(null);
      else {
        const alreadyExists = edges.some((edge) => edge.sourceId === connectingFrom && edge.targetId === note.id);
        if (!alreadyExists) { pushHistory(); setEdges((current) => [...current, { id: uid("edge"), sourceId: connectingFrom, targetId: note.id }]); }
        setConnectingFrom(null); setTool("select"); setToast("Verbindung angelegt");
      }
      return;
    }
    setSelectedId(note.id);
    setSelectedEdgeId(null);
  };

  const startPointerAction = (event: ReactPointerEvent, note: Note, mode: "move" | "resize") => {
    if (layoutMode === "tidy") {
      setToast("Die sortierte Ansicht ordnet Positionen automatisch an");
      return;
    }
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
      setNotes((current) => current.map((note) => note.id === dragState.id ? { ...note, x: clamp(original.x + dx, 0, 100 - note.width), y: clamp(original.y + dy, 0, 100 - note.height) } : note));
    } else {
      const angle = ((original.rotation ?? 0) * Math.PI) / 180;
      const pointerX = event.clientX - dragState.startX;
      const pointerY = event.clientY - dragState.startY;
      const localWidthDelta = ((pointerX * Math.cos(angle) + pointerY * Math.sin(angle)) / rect.width) * 100;
      const localHeightDelta = ((-pointerX * Math.sin(angle) + pointerY * Math.cos(angle)) / rect.height) * 100;
      setNotes((current) => current.map((note) => note.id === dragState.id ? {
        ...note,
        width: clamp(original.width + localWidthDelta, MIN_RESIZE_SIZE, 100 - original.x),
        height: clamp(original.height + localHeightDelta, MIN_RESIZE_SIZE, 100 - original.y),
      } : note));
    }
  };

  const analyzeFile = useCallback(async (file: File) => {
    if (isAnalyzing) { setToast("Die aktuelle Analyse läuft noch"); return; }
    if (!file.type.startsWith("image/")) { setToast("Bitte ein JPG-, PNG- oder WebP-Bild wählen"); return; }
    if (file.size > 24 * 1024 * 1024) { setToast("Das Bild ist größer als 24 MB"); return; }

    const scanId = scanGenerationRef.current + 1;
    scanGenerationRef.current = scanId;
    pushHistory();
    releaseImageObjectUrl();
    setImageSrc(null);
    setFileName(file.name);
    setShowPhoto(true);
    setLayoutMode("original");
    setNotes([]);
    setEdges([]);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setAnalysisElapsed(0);
    setOcrDiagnostics(null);
    setIsAnalyzing(true);
    setAnalysisProgress(2);
    setStatus("Foto wird vorbereitet");

    const src = URL.createObjectURL(file);
    imageObjectUrlRef.current = src;
    setImageSrc(src);
    try {
      const detected = await detectStickyNotes(
        src,
        (progress, label) => {
          if (scanGenerationRef.current !== scanId) return;
          setAnalysisProgress(progress);
          setStatus(label);
        },
        (geometry) => {
          if (scanGenerationRef.current !== scanId) return;
          setBoardAspectRatio(geometry.aspectRatio);
          setNotes(geometry.notes);
          setSelectedId(geometry.notes[0]?.id ?? null);
        },
      );
      if (scanGenerationRef.current !== scanId) return;
      setBoardAspectRatio(detected.aspectRatio);
      setNotes(detected.notes);
      setOcrDiagnostics(detected.diagnostics ?? null);
      setSelectedId(detected.notes[0]?.id ?? null);
      if (new URLSearchParams(window.location.search).get("ocrDebug") === "1") {
        const snapshot = { diagnostics: detected.diagnostics ?? null, notes: detected.notes };
        (window as Window & { __STICKY_NOTE_LAB_OCR_DIAGNOSTICS__?: typeof snapshot }).__STICKY_NOTE_LAB_OCR_DIAGNOSTICS__ = snapshot;
        window.dispatchEvent(new CustomEvent("ocr-diagnostics", { detail: snapshot }));
      }
      setToast(detected.notes.length
        ? `${detected.notes.length} Notizen angelegt${detected.symbolCount ? ` · ${detected.symbolCount} Symbole erkannt` : ""}`
        : "Keine sicheren Notizen – mit + manuell ergänzen");
    } catch (error) {
      if (scanGenerationRef.current !== scanId) return;
      console.error(error);
      setStatus("Analyse fehlgeschlagen – du kannst Notizen manuell anlegen");
      setToast("Analyse fehlgeschlagen");
    } finally {
      if (scanGenerationRef.current === scanId) {
        setIsAnalyzing(false);
        setAnalysisProgress(100);
      }
    }
  }, [isAnalyzing, pushHistory, releaseImageObjectUrl]);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void analyzeFile(file);
    event.target.value = "";
  };

  const exportJson = () => {
    setShowExportMenu(false);
    const payload = { format: BOARD_EXPORT_FORMAT, version: 4, createdAt: new Date().toISOString(), layoutMode, source: { fileName, photoIncluded: false, aspectRatio: boardAspectRatio }, notes, edges };
    downloadBlob("sticky-note-lab-board.json", new Blob([JSON.stringify(payload, (key, value) => key === "ocrEvidence" ? undefined : value, 2)], { type: "application/json" }));
    setToast("Board als JSON exportiert");
  };

  const exportPowerPoint = async () => {
    if (isExportingPowerPoint) return;
    setShowExportMenu(false);
    setIsExportingPowerPoint(true);
    setToast("PowerPoint wird erstellt …");
    try {
      const { exportBoardToPowerPoint } = await import("./powerpoint-export");
      await exportBoardToPowerPoint({
        notes: displayNotes,
        edges,
        aspectRatio: boardAspectRatio,
        title: fileName || "Sticky Note Lab Board",
      });
      setToast("Bearbeitbare PowerPoint exportiert");
    } catch (error) {
      console.error("PowerPoint-Export fehlgeschlagen", error);
      setToast("PowerPoint konnte nicht erstellt werden");
    } finally {
      setIsExportingPowerPoint(false);
    }
  };

  const exportSpreadsheet = async (format: "xlsx" | "csv") => {
    if (isExportingSpreadsheet) return;
    setShowExportMenu(false);
    setIsExportingSpreadsheet(true);
    setToast(format === "xlsx" ? "Excel-Datei wird erstellt …" : "CSV-Datei wird erstellt …");
    try {
      const { createBoardCsv, createBoardExcelBlob } = await import("./spreadsheet-export");
      if (format === "xlsx") {
        const blob = await createBoardExcelBlob(displayNotes, fileName || "Sticky Note Lab Board");
        downloadBlob("sticky-note-lab-post-its.xlsx", blob);
        setToast("Post-it-Daten als Excel exportiert");
      } else {
        const csv = createBoardCsv(displayNotes);
        downloadBlob("sticky-note-lab-post-its.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
        setToast("Post-it-Daten als CSV exportiert");
      }
    } catch (error) {
      console.error("Tabellenexport fehlgeschlagen", error);
      setToast("Tabelle konnte nicht erstellt werden");
    } finally {
      setIsExportingSpreadsheet(false);
    }
  };

  const importJson = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result));
        const supportedFormat = payload?.format === BOARD_EXPORT_FORMAT || payload?.format === LEGACY_BOARD_EXPORT_FORMAT;
        if (!supportedFormat || !Array.isArray(payload.notes) || !Array.isArray(payload.edges)) throw new Error("Unbekanntes Format");
        pushHistory();
        const importedNotes = payload.notes.map((note: Note, index: number): Note => ({
          ...note,
          rotation: Number.isFinite(Number(note.rotation)) ? Number(note.rotation) : 0,
          zIndex: Number.isFinite(Number(note.zIndex)) ? Number(note.zIndex) : index + 2,
          origin: note.origin ?? "import",
        }));
        releaseImageObjectUrl();
        setImageSrc(null);
        setFileName(payload.source?.fileName ?? "Importiertes Board");
        setNotes(importedNotes);
        setEdges(payload.edges);
        setLayoutMode(payload.layoutMode === "tidy" ? "tidy" : "original");
        setBoardAspectRatio(Number(payload.source?.aspectRatio) || 1.6);
        setSelectedId(importedNotes[0]?.id ?? null);
        setStatus("Importiertes Board bereit");
        setToast("Board importiert");
      } catch { setToast("Dieses JSON ist kein gültiges Sticky-Note-Lab-Board"); }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const exportPng = () => {
    const width = 1600;
    const height = Math.round(width / boardAspectRatio);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f5f1e8"; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = "rgba(44, 42, 36, .06)";
    for (let x = 0; x < width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    for (const edge of edges) {
      const source = displayNotes.find((note) => note.id === edge.sourceId);
      const target = displayNotes.find((note) => note.id === edge.targetId);
      if (!source || !target) continue;
      const a = noteCenter(source); const b = noteCenter(target);
      ctx.strokeStyle = "#4a4944"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo((a.x / 100) * width, (a.y / 100) * height); ctx.lineTo((b.x / 100) * width, (b.y / 100) * height); ctx.stroke();
    }
    const drawingOrder = [...displayNotes].sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));
    for (const note of drawingOrder) {
      const x = (note.x / 100) * width; const y = (note.y / 100) * height; const w = (note.width / 100) * width; const h = (note.height / 100) * height;
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(((note.rotation ?? 0) * Math.PI) / 180);
      ctx.fillStyle = "rgba(53, 45, 26, .15)"; ctx.fillRect(-w / 2 + 8, -h / 2 + 10, w, h);
      ctx.fillStyle = note.color; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.fillStyle = "#24241f"; ctx.font = "600 26px Arial";
      const words = note.text.split(/\s+/); let line = ""; let lineY = -h / 2 + 45;
      for (const word of words) { const test = `${line}${word} `; if (ctx.measureText(test).width > w - 42 && line) { ctx.fillText(line.trim(), -w / 2 + 22, lineY); line = `${word} `; lineY += 34; } else line = test; }
      ctx.fillText(line.trim(), -w / 2 + 22, lineY);
      ctx.restore();
    }
    canvas.toBlob((blob) => { if (blob) downloadBlob("sticky-note-lab-board.png", blob); }, "image/png");
    setToast("Board als PNG exportiert");
  };

  const resetDemo = () => {
    scanGenerationRef.current += 1;
    pushHistory();
    releaseImageObjectUrl();
    setNotes(DEMO_NOTES.map((note) => ({ ...note })));
    setEdges(DEMO_EDGES.map((edge) => ({ ...edge })));
    setImageSrc(null);
    setFileName("");
    setBoardAspectRatio(1.6);
    setLayoutMode("original");
    setStatus("Beispielboard bereit");
    setAnalysisElapsed(0);
    setOcrDiagnostics(null);
    setAnalysisProgress(100);
    setIsAnalyzing(false);
    setSelectedId("note-2");
    setSelectedEdgeId(null);
  };

  const edgeElements = useMemo(() => edges.map((edge) => {
    const source = displayNotes.find((note) => note.id === edge.sourceId);
    const target = displayNotes.find((note) => note.id === edge.targetId);
    if (!source || !target) return null;
    return <path key={edge.id} d={makeCurve(source, target)} className={selectedEdgeId === edge.id ? "edge selected" : "edge"} markerEnd="url(#arrowhead)" onClick={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedId(null); }} />;
  }), [displayNotes, edges, selectedEdgeId]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><h1>Sticky Note Lab</h1><p>Vom Foto zum editierbaren Board</p></div></div>
        <div className="project-name"><span className="status-dot" /><strong>{fileName || "Workshop-Experiment"}</strong><ChevronDown size={15} /></div>
        <div className="header-actions">
          <button className="icon-button" aria-label="Rückgängig" title="Rückgängig" disabled={!history.length} onClick={undo}><Undo2 size={18} /></button>
          <button className="icon-button" aria-label="Wiederholen" title="Wiederholen" disabled={!future.length} onClick={redo}><Redo2 size={18} /></button>
          <div className={`export-menu ${showExportMenu ? "open" : ""}`}><button className="primary-button" aria-haspopup="menu" aria-expanded={showExportMenu} onClick={() => setShowExportMenu((value) => !value)}><Download size={16} /> Exportieren <ChevronDown size={14} /></button><div className="export-popover" role="menu"><button role="menuitem" onClick={exportJson}><FileJson size={16} /> Board-JSON</button><button role="menuitem" onClick={() => void exportPowerPoint()} disabled={isExportingPowerPoint}><Presentation size={16} /> {isExportingPowerPoint ? "PowerPoint wird erstellt …" : "PowerPoint (.pptx)"}</button><button role="menuitem" onClick={() => void exportSpreadsheet("xlsx")} disabled={isExportingSpreadsheet}><FileSpreadsheet size={16} /> {isExportingSpreadsheet ? "Tabelle wird erstellt …" : "Excel (.xlsx)"}</button><button role="menuitem" onClick={() => void exportSpreadsheet("csv")} disabled={isExportingSpreadsheet}><FileSpreadsheet size={16} /> CSV-Tabelle</button><button role="menuitem" onClick={() => { setShowExportMenu(false); exportPng(); }}><ImagePlus size={16} /> PNG-Bild</button><button role="menuitem" onClick={() => { setShowExportMenu(false); importInputRef.current?.click(); }}><Upload size={16} /> JSON importieren</button></div></div>
          <button className="avatar" aria-label="Lokales Profil">DU</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-panel panel">
          <div className="panel-heading"><div><span className="eyebrow">QUELLE</span><h2>Board-Foto</h2></div><CircleHelp size={17} /></div>
          <button className={`drop-zone ${isDraggingOver ? "dragging" : ""}`} disabled={isAnalyzing} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); if (!isAnalyzing) setIsDraggingOver(true); }} onDragLeave={() => setIsDraggingOver(false)} onDrop={(event) => { event.preventDefault(); setIsDraggingOver(false); const file = event.dataTransfer.files[0]; if (file) void analyzeFile(file); }}>
            <div className="upload-icon"><ImagePlus size={25} /></div><strong>{imageSrc ? "Anderes Foto wählen" : "Foto hier ablegen"}</strong><span>oder klicken · JPG, PNG, WebP</span>
          </button>
          {imageSrc ? (
            <div className="source-preview">
              <img src={imageSrc} alt="Hochgeladenes Haftnotiz-Board" />
              <button className="preview-remove" onClick={() => { releaseImageObjectUrl(); setImageSrc(null); setFileName(""); setBoardAspectRatio(1.6); }} aria-label="Foto entfernen"><X size={15} /></button><div className="preview-name"><Check size={15} /> <span>{fileName}</span></div>
            </div>
          ) : <div className="capture-tips"><Sparkles size={17} /><div><strong>Für gute Ergebnisse</strong><p>Gerade fotografieren, Reflexionen vermeiden und möglichst nah ans Board gehen.</p></div></div>}
          <div className="analysis-card" role="status" aria-live="polite">
            <div className="analysis-title"><span className={isAnalyzing ? "analyzing-badge pulse" : "analyzing-badge"}>{isAnalyzing ? <LoaderCircle size={14} /> : <ScanLine size={14} />}{isAnalyzing ? "ANALYSE LÄUFT" : "BEREIT"}</span><span>{analysisProgress}%</span></div>
            <div className={isAnalyzing ? "progress-track active" : "progress-track"}><span style={{ width: `${analysisProgress}%` }} /></div>
            <p className="analysis-status">{status}</p>
            {ocrDiagnostics && <div className="engine-health" aria-label="Status der Texterkennung">
              {([
                ["paddle", "Paddle", ocrDiagnostics.paddle],
                ["dehtr", "DE·HTR", ocrDiagnostics.dehtr],
                ["tesseract", "Tesseract", ocrDiagnostics.tesseract],
              ] as const).map(([engine, label, diagnostic]) => (
                <span key={engine} data-engine={engine} data-engine-status={diagnostic.status} className={`engine-chip ${diagnostic.status}`} title={diagnostic.error}>
                  {diagnostic.status === "ready" ? "✓" : diagnostic.status === "partial" ? "≈" : diagnostic.status === "failed" ? "!" : "–"} {label}
                  {(diagnostic.status === "ready" || diagnostic.status === "partial") && diagnostic.candidateCount > 0 ? ` ${diagnostic.candidateCount}` : ""}
                </span>
              ))}
            </div>}
            {isAnalyzing && <div className="analysis-meta"><span><i className="activity-dot" aria-hidden="true" />Aktiv seit {formatElapsed(analysisElapsed)}</span><span>Schritt {analysisStep}/6</span></div>}
            {isModelStarting && <p className="model-hint">Erster KI-Start: Das Modell wird einmal geladen und auf diesem Gerät eingerichtet. Tab bitte offen lassen.</p>}
            {isFallbackRunning && <p className="model-hint fallback-hint">Selektiver Fallback: Nur die schwierigsten Notizen werden noch gegengeprüft. Dieser Schritt besitzt jetzt ein festes Zeitlimit.</p>}
          </div>
          <button className="secondary-button full pipeline-open-button" onClick={() => setShowPipeline(true)}><ScanLine size={16} /> Scanner-Schritte ansehen</button>
          <div className="layer-section">
            <div className="section-label"><span>EBENEN</span><Plus size={15} /></div>
            <button className="layer-row active" onClick={() => setShowPhoto((value) => !value)}><span className="layer-thumb"><ImagePlus size={15} /></span><span><strong>Originalfoto</strong><small>gesperrter Hintergrund</small></span>{showPhoto ? <Eye size={16} /> : <EyeOff size={16} />}</button>
            <button className="layer-row"><span className="layer-thumb notes"><GripVertical size={15} /></span><span><strong>Digitale Notizen</strong><small>{notes.length} Objekte</small></span><Eye size={16} /></button>
            <label className="opacity-control"><span>Foto-Deckkraft</span><strong>{photoOpacity}%</strong><input type="range" min="0" max="90" value={photoOpacity} onChange={(event) => setPhotoOpacity(Number(event.target.value))} /></label>
          </div>
          <button className="secondary-button full" onClick={resetDemo}><RotateCcw size={16} /> Beispiel zurücksetzen</button>
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div className="tool-group"><button className={tool === "select" ? "tool active" : "tool"} onClick={() => { setTool("select"); setConnectingFrom(null); }} title="Auswählen"><MousePointer2 size={18} /></button><button className="tool" onClick={addNote} title="Notiz hinzufügen"><Plus size={19} /></button><button className={tool === "connect" ? "tool active" : "tool"} onClick={() => { setTool("connect"); setConnectingFrom(null); }} title="Verbinden"><Link2 size={18} /></button><span className="tool-separator" /><button className="tool" onClick={() => setShowPhoto((value) => !value)} title="Foto ein-/ausblenden">{showPhoto ? <Eye size={18} /> : <EyeOff size={18} />}</button><button className="tool" onClick={() => setZoom(100)} title="Ansicht zentrieren"><Focus size={18} /></button></div>
            <div className="layout-switch" role="group" aria-label="Board-Anordnung">
              <button type="button" className={layoutMode === "original" ? "active" : ""} aria-pressed={layoutMode === "original"} onClick={() => { setLayoutMode("original"); setToast("Anordnung wie im Foto"); }}>Wie im Foto</button>
              <button type="button" className={layoutMode === "tidy" ? "active" : ""} aria-pressed={layoutMode === "tidy"} onClick={() => { setLayoutMode("tidy"); setToast("Notizen gerade und ohne Überlappung sortiert"); }}>Sortiert</button>
            </div>
            <div className="canvas-summary"><span><i className="mini-dot yellow" /> {notes.length} Notizen</span><span><Link2 size={13} /> {edges.length} Verbindungen</span>{lowConfidenceCount > 0 && <span className="warning-summary">{lowConfidenceCount} prüfen</span>}</div>
          </div>
          <div className="canvas-viewport">
            <div ref={boardRef} className={`board ${imageSrc ? "photo-board" : ""} ${layoutMode === "tidy" ? "tidy-board" : ""} ${tool === "connect" ? "connecting" : ""}`} style={{ transform: `scale(${zoom / 100})`, aspectRatio: boardAspectRatio }}>
              {imageSrc && showPhoto && layoutMode === "original" && <img className="board-photo" src={imageSrc} alt="" style={{ opacity: photoOpacity / 100 }} />}
              <svg className="edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Verbindungen"><defs><marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L6,3 z" fill="currentColor" /></marker></defs>{edgeElements}</svg>
              {displayNotes.map((note, index) => (
                <div key={note.id} role="button" tabIndex={0} className={`sticky-note ${note.origin === "scan" ? "detected-note" : ""} ${layoutMode === "tidy" ? "auto-arranged" : ""} ${selectedId === note.id ? "selected" : ""} ${connectingFrom === note.id ? "connect-source" : ""} ${note.confidence < 70 ? "low-confidence" : ""}`} style={{ left: `${note.x}%`, top: `${note.y}%`, width: `${note.width}%`, height: `${note.height}%`, background: note.color, transform: `rotate(${note.rotation ?? 0}deg)`, zIndex: selectedId === note.id ? maximumDisplayLayer + 10 : note.zIndex ?? index + 2 }} onClick={(event) => handleNoteClick(event, note)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleNoteClick(event as unknown as ReactMouseEvent, note); } }} onPointerDown={(event) => startPointerAction(event, note, "move")} onPointerMove={movePointerAction} onPointerUp={() => setDragState(null)} onPointerCancel={() => setDragState(null)}>
                  {note.origin !== "scan" && layoutMode === "original" && <div className="note-tape" />}{note.confidence < 70 && <span className="confidence-flag" title="Text bitte prüfen">?</span>}
                  <textarea value={note.text} placeholder="Text eingeben …" aria-label="Notiztext" spellCheck onPointerDown={(event) => event.stopPropagation()} onFocus={() => { pushHistory(); setSelectedId(note.id); setSelectedEdgeId(null); }} onChange={(event) => setNotes((current) => current.map((item) => item.id === note.id ? { ...item, text: event.target.value, confidence: 100, corrections: [] } : item))} />
                  {selectedId === note.id && tool === "select" && layoutMode === "original" && <button className="resize-handle" aria-label="Notizgröße ändern" onPointerDown={(event) => startPointerAction(event, note, "resize")} onPointerMove={movePointerAction} onPointerUp={() => setDragState(null)}><Maximize2 size={12} /></button>}
                </div>
              ))}
              {isAnalyzing && <div className="analysis-overlay" aria-hidden="true"><div className="scanner-line" /><div className="analysis-modal"><WandSparkles size={24} /><span className="analysis-modal-copy"><strong>{status}</strong><small><i className="activity-dot" />Aktiv · {formatElapsed(analysisElapsed)} · Schritt {analysisStep}/6</small></span><span>{analysisProgress}%</span></div></div>}
            </div>
            <div className="zoom-control"><button onClick={() => setZoom((value) => clamp(value - 10, 60, 150))}><ZoomOut size={16} /></button><button className="zoom-value" onClick={() => setZoom(100)}>{zoom}%</button><button onClick={() => setZoom((value) => clamp(value + 10, 60, 150))}><ZoomIn size={16} /></button></div>
            <div className="privacy-pill"><span /> Verarbeitung lokal im Browser</div>
          </div>
        </section>

        <aside className="right-panel panel">
          <div className="panel-heading inspector-title"><div><span className="eyebrow">INSPEKTOR</span><h2>{selectedNote ? "Notiz bearbeiten" : selectedEdgeId ? "Verbindung" : "Board"}</h2></div>{selectedNote && <span className="object-index">#{notes.findIndex((note) => note.id === selectedNote.id) + 1}</span>}</div>
          {selectedNote ? (
            <div className="inspector-content">
              <label className="field-label" htmlFor="note-text">TEXT</label><textarea id="note-text" className="inspector-textarea" value={selectedNote.text} placeholder="Text eingeben …" onFocus={pushHistory} onChange={(event) => updateNote(selectedNote.id, { text: event.target.value, confidence: 100, corrections: [] }, false)} />
              <div className="field-label">SYMBOLE</div><div className="symbol-picker" role="group" aria-label="Symbol einfügen">{SIMPLE_SYMBOLS.map((symbol) => <button key={symbol} type="button" className="symbol-button" title={SIMPLE_SYMBOL_LABELS[symbol]} aria-label={`${SIMPLE_SYMBOL_LABELS[symbol]} einfügen`} onClick={() => insertSymbol(symbol)}>{symbol}</button>)}</div>
              {!!selectedNote.symbols?.length && <div className="symbol-result-card"><strong>{selectedNote.symbols.length} aus dem Foto erkannt</strong><div>{selectedNote.symbols.map((entry, index) => <span key={`${entry.symbol}-${index}`} title={`${entry.label}: ${entry.confidence}%`}>{entry.symbol}<small>{entry.confidence}%</small></span>)}</div></div>}
              <div className="confidence-row"><span>Erkennung</span><span className={selectedNote.confidence < 70 ? "confidence weak" : "confidence"}>{selectedNote.confidence || 0}%</span></div>
              {!!selectedNote.corrections?.length && <div className="correction-card">
                <div className="correction-title"><Sparkles size={14} /><strong>{selectedNote.corrections.length} OCR-Korrektur{selectedNote.corrections.length === 1 ? "" : "en"}</strong></div>
                <div className="correction-list">{selectedNote.corrections.slice(0, 4).map((correction, index) => <span key={`${correction.start}-${index}`}><del>{correction.from}</del><b>→</b>{correction.to}</span>)}</div>
                <button onClick={() => updateNote(selectedNote.id, {
                  text: selectedNote.rawText ?? selectedNote.text,
                  confidence: selectedNote.rawConfidence ?? selectedNote.confidence,
                  corrections: [],
                })}>OCR-Original wiederherstellen</button>
              </div>}
              <div className="field-label">FARBE</div><div className="palette" role="group" aria-label="Notizfarbe">{PALETTE.map((color) => <button key={color} className={selectedNote.color === color ? "swatch selected" : "swatch"} style={{ background: color }} aria-label={`Farbe ${color}`} onClick={() => updateNote(selectedNote.id, { color })}>{selectedNote.color === color && <Check size={15} />}</button>)}</div>
              {layoutMode === "original" ? <>
                <div className="field-label">POSITION, GRÖSSE & DREHUNG</div>
                <div className="number-grid">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{field === "width" ? "B" : field === "height" ? "H" : field.toUpperCase()}</span><input type="number" value={Math.round(selectedNote[field] * 10) / 10} min="0" max="100" step="0.5" onFocus={pushHistory} onChange={(event) => updateNote(selectedNote.id, { [field]: Number(event.target.value) }, false)} /><small>%</small></label>)}</div>
                <label className="rotation-field"><span>Drehung</span><input type="number" value={Math.round((selectedNote.rotation ?? 0) * 10) / 10} min="-180" max="180" step="0.5" onFocus={pushHistory} onChange={(event) => updateNote(selectedNote.id, { rotation: clamp(Number(event.target.value), -180, 180) }, false)} /><small>°</small></label>
              </> : <div className="auto-layout-hint"><strong>Automatisch angeordnet</strong><span>Text, Farbe und Verbindungen bleiben bearbeitbar. Positionen änderst du im Modus „Wie im Foto“.</span></div>}
              <button className="secondary-button full connection-button" onClick={() => { setTool("connect"); setConnectingFrom(selectedNote.id); }}><Link2 size={16} /> Von hier verbinden</button><button className="danger-button full" onClick={deleteSelection}><Trash2 size={16} /> Notiz löschen</button>
            </div>
          ) : selectedEdgeId ? (
            <div className="empty-inspector"><div className="empty-icon"><ArrowRight size={22} /></div><h3>Verbindung ausgewählt</h3><p>Die Verbindung bleibt an beiden Notizen befestigt, wenn du sie verschiebst.</p><button className="danger-button full" onClick={deleteSelection}><Unlink size={16} /> Verbindung löschen</button></div>
          ) : (
            <div className="empty-inspector"><div className="empty-icon"><MousePointer2 size={22} /></div><h3>Wähle eine Notiz</h3><p>Dann kannst du Text, Farbe, Position und Größe direkt anpassen.</p><div className="board-stats"><span><strong>{notes.length}</strong> Notizen</span><span><strong>{edges.length}</strong> Verbindungen</span><span><strong>{confidenceAverage}%</strong> OCR Ø</span></div></div>
          )}
          <div className="local-card"><div className="local-icon"><Check size={16} /></div><div><strong>Dein Foto bleibt hier</strong><p>Kein Upload, kein Account. Das Experiment läuft auf deinem Gerät.</p></div></div>
        </aside>
      </section>
      <PipelineVisualization open={showPipeline} onClose={() => setShowPipeline(false)} imageSrc={imageSrc} fileName={fileName} notes={notes} diagnostics={ocrDiagnostics} isAnalyzing={isAnalyzing} analysisProgress={analysisProgress} />
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={isAnalyzing} onChange={onFileInput} /><input ref={importInputRef} type="file" accept="application/json" hidden onChange={importJson} />{toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </main>
  );
}

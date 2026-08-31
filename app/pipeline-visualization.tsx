"use client";

import {
  BrainCircuit, Check, ChevronLeft, ChevronRight, Crop, GitMerge, Image as ImageIcon,
  Layers3, Pause, PencilRuler, Play, ScanLine, SlidersHorizontal, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { OcrRunDiagnostics } from "./ocr-engine";

type PipelineNote = {
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
  rawText?: string;
  corrections?: Array<{ from: string; to: string }>;
};

type PipelineVisualizationProps = {
  open: boolean;
  onClose: () => void;
  imageSrc: string | null;
  fileName: string;
  notes: PipelineNote[];
  diagnostics: OcrRunDiagnostics | null;
  isAnalyzing: boolean;
  analysisProgress: number;
};

const STEPS = [
  { short: "Foto", title: "1 · Foto lokal dekodieren", icon: ImageIcon, detail: "Der Browser liest die Originalpixel. Es findet kein Upload statt." },
  { short: "Farbe", title: "2 · Farben im Lab-Raum gruppieren", icon: Layers3, detail: "Ähnliche wahrgenommene Papierfarben werden zu stabilen Clustern zusammengefasst." },
  { short: "Geometrie", title: "3 · Zettel und Überlappungen rekonstruieren", icon: ScanLine, detail: "Kanten, Farbflächen und sichtbare Fragmente liefern Ecken, Drehung und Ebenenreihenfolge." },
  { short: "Crop", title: "4 · Perspektive entzerren", icon: Crop, detail: "Vier Quellpunkte werden auf ein gerades Rechteck projiziert – wie bei einem Dokumentenscanner." },
  { short: "Filter", title: "5 · Sechs Bildvarianten erzeugen", icon: SlidersHorizontal, detail: "Farbe, Grau, Schattenausgleich, Kontrast, Sauvola und Tintenmaske machen andere Schriftzüge sichtbar." },
  { short: "OCR", title: "6 · Drei Leser parallel befragen", icon: BrainCircuit, detail: "PaddleOCR, DE·HTR und Tesseract erzeugen unabhängige Textkandidaten für Notiz und Zeilen." },
  { short: "Konsens", title: "7 · Evidenz zusammenführen", icon: GitMerge, detail: "Vollständigkeit, Übereinstimmung, Konfidenz und vorsichtige Wörterbuchkorrekturen bestimmen den Gewinner." },
  { short: "Editor", title: "8 · Editierbares Board aufbauen", icon: PencilRuler, detail: "Text, Farbe, Größe, Position, Drehung und Ebenen werden zu veränderbaren React-Objekten." },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cropBackground(imageSrc: string | null, note: PipelineNote | undefined): CSSProperties {
  if (!imageSrc || !note) return { background: note?.color ?? "#f7dc68" };
  const horizontal = note.width >= 99 ? 50 : clamp(note.x / Math.max(1, 100 - note.width) * 100, 0, 100);
  const vertical = note.height >= 99 ? 50 : clamp(note.y / Math.max(1, 100 - note.height) * 100, 0, 100);
  return {
    backgroundImage: `url("${imageSrc}")`,
    backgroundSize: `${10000 / Math.max(1, note.width)}% ${10000 / Math.max(1, note.height)}%`,
    backgroundPosition: `${horizontal}% ${vertical}%`,
    backgroundRepeat: "no-repeat",
  };
}

function MiniBoard({ imageSrc, notes, mode }: { imageSrc: string | null; notes: PipelineNote[]; mode: "photo" | "clusters" | "geometry" | "editor" }) {
  return (
    <div className={`pipeline-board pipeline-board-${mode}`} role="img" aria-label={`Visualisierung: ${mode}`}>
      {imageSrc && mode !== "editor" ? <img src={imageSrc} alt="" /> : <div className="pipeline-grid" />}
      {notes.map((note, index) => {
        if (mode === "photo") return null;
        const style: CSSProperties = {
          left: `${note.x}%`, top: `${note.y}%`, width: `${note.width}%`, height: `${note.height}%`,
          background: mode === "clusters" ? note.color : undefined,
          transform: `rotate(${mode === "editor" ? note.rotation ?? 0 : note.rotation ?? 0}deg)`,
          zIndex: note.zIndex ?? index + 1,
        };
        return <div key={note.id} className="pipeline-note-mark" style={style}>
          {mode === "geometry" && <><i /><i /><i /><i /><span>#{index + 1}</span></>}
          {mode === "editor" && <strong style={{ background: note.color }}>{note.text || "Text …"}</strong>}
        </div>;
      })}
      {mode === "photo" && <div className="pipeline-scan-beam" />}
    </div>
  );
}

function StageFrame({ children, label }: { children: ReactNode; label: string }) {
  return <div className="pipeline-stage-frame"><span className="pipeline-stage-label">{label}</span>{children}</div>;
}

export function PipelineVisualization({
  open, onClose, imageSrc, fileName, notes, diagnostics, isAnalyzing, analysisProgress,
}: PipelineVisualizationProps) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = STEPS[step];
  const activeNote = useMemo(() => notes.find((note) => note.text.trim()) ?? notes[0], [notes]);

  useEffect(() => {
    if (!open || !playing) return;
    const timer = window.setInterval(() => setStep((value) => {
      if (value >= STEPS.length - 1) {
        setPlaying(false);
        return value;
      }
      return value + 1;
    }), 1850);
    return () => window.clearInterval(timer);
  }, [open, playing]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") setStep((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setStep((value) => Math.min(STEPS.length - 1, value + 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const rawText = activeNote?.rawText?.trim() || activeNote?.text?.trim() || "Noch kein OCR-Kandidat";
  const finalText = activeNote?.text?.trim() || "Text wird nach dem Scan hier sichtbar";
  const engineRows = diagnostics ? [
    ["PaddleOCR", diagnostics.paddle],
    ["DE·HTR", diagnostics.dehtr],
    ["Tesseract", diagnostics.tesseract],
  ] as const : null;

  return (
    <div className="pipeline-backdrop">
      <section className="pipeline-dialog" role="dialog" aria-modal="true" aria-labelledby="pipeline-title">
        <header className="pipeline-header">
          <div><span className="eyebrow">LIVE-ERKLÄRUNG</span><h2 id="pipeline-title">Was der Scanner im Hintergrund macht</h2><p>{imageSrc ? fileName || "Aktuelles Board-Foto" : "Simulation mit dem Beispielboard"}</p></div>
          <button className="pipeline-close" onClick={onClose} aria-label="Visualisierung schließen"><X size={20} /></button>
        </header>

        <nav className="pipeline-stepper" aria-label="Verarbeitungsschritte">
          {STEPS.map((entry, index) => {
            const Icon = entry.icon;
            return <button key={entry.short} className={index === step ? "active" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined} onClick={() => { setPlaying(false); setStep(index); }}><span>{index < step ? <Check size={13} /> : <Icon size={13} />}</span><small>{entry.short}</small></button>;
          })}
        </nav>

        <div className="pipeline-current" aria-live="polite">
          <div className="pipeline-current-copy"><span>Schritt {step + 1} von {STEPS.length}</span><h3>{current.title}</h3><p>{current.detail}</p></div>
          {isAnalyzing && <div className="pipeline-live"><i /> LIVE · {analysisProgress}%</div>}
        </div>

        <div className="pipeline-visual">
          {step === 0 && <StageFrame label="Originalpixel · lokal im Browser"><MiniBoard imageSrc={imageSrc} notes={notes} mode="photo" /><div className="pipeline-facts"><span>Canvas 2D</span><span>Originalauflösung</span><span>Kein Upload</span></div></StageFrame>}
          {step === 1 && <StageFrame label="CIELAB · L* Helligkeit · a*/b* Farbe"><MiniBoard imageSrc={imageSrc} notes={notes} mode="clusters" /><div className="pipeline-palette">{[...new Set(notes.map((note) => note.color))].slice(0, 8).map((color) => <span key={color} style={{ background: color }} aria-label={`Erkannte Farbgruppe ${color}`} />)}</div></StageFrame>}
          {step === 2 && <StageFrame label="Connected Components + Kantenmodell"><MiniBoard imageSrc={imageSrc} notes={notes} mode="geometry" /><div className="pipeline-facts"><span>{notes.length} Kandidaten</span><span>4 Ecken je Zettel</span><span>Z-Reihenfolge</span></div></StageFrame>}
          {step === 3 && <StageFrame label="Projektive Transformation"><div className="pipeline-transform"><div><small>im Foto</small><div className="pipeline-crop skewed" style={{ ...cropBackground(imageSrc, activeNote), transform: `rotate(${activeNote?.rotation ?? -8}deg)` }}>{!imageSrc && <b>{rawText}</b>}</div></div><ChevronRight size={26} /><div><small>entzerrt</small><div className="pipeline-crop straight" style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}</div></div></div></StageFrame>}
          {step === 4 && <StageFrame label="Mehrfachvorverarbeitung desselben Original-Crops"><div className="pipeline-filter-grid">{[
            ["RGB", "rgb"], ["Graustufen", "gray"], ["Schattenausgleich", "shadow"], ["Kontrast", "contrast"], ["Sauvola S/W", "sauvola"], ["Nur Tinte", "ink"],
          ].map(([label, variant]) => <div key={variant}><span>{label}</span><div className={`pipeline-filter pipeline-filter-${variant}`} style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}</div></div>)}</div></StageFrame>}
          {step === 5 && <StageFrame label="Unabhängige neuronale und klassische Leser"><div className="pipeline-readers">{(engineRows ?? [["PaddleOCR", null], ["DE·HTR", null], ["Tesseract", null]]).map(([name, engine], index) => <div key={name} className="pipeline-reader"><span>{index + 1}</span><div><strong>{name}</strong><small>{engine ? `${engine.status} · ${engine.candidateCount} Kandidaten` : "bereit für den ersten Lauf"}</small></div><em>{index === 0 ? "ganze Notiz + Zeilen" : index === 1 ? "Handschriftzeilen" : "unabhängiger Fallback"}</em></div>)}</div></StageFrame>}
          {step === 6 && <StageFrame label="Evidence Fusion · keine blinde Einzelentscheidung"><div className="pipeline-fusion"><div><small>Beobachteter OCR-Text</small><p>{rawText}</p></div><GitMerge size={30} /><div className="pipeline-consensus"><small>Gewählter Konsens</small><p>{finalText}</p><span>{activeNote?.confidence ?? 0}% Konfidenz</span></div></div>{!!activeNote?.corrections?.length && <div className="pipeline-corrections">{activeNote.corrections.slice(0, 4).map((correction, index) => <span key={`${correction.from}-${index}`}><del>{correction.from}</del> → <b>{correction.to}</b></span>)}</div>}</StageFrame>}
          {step === 7 && <StageFrame label="React-Zustand · jedes Objekt bleibt veränderbar"><MiniBoard imageSrc={null} notes={notes} mode="editor" /><div className="pipeline-facts"><span>Text editierbar</span><span>Farbe & Position</span><span>Verbindungen möglich</span></div></StageFrame>}
        </div>

        <footer className="pipeline-footer">
          <button className="secondary-button" onClick={() => { setPlaying(false); setStep((value) => Math.max(0, value - 1)); }} disabled={step === 0}><ChevronLeft size={16} /> Zurück</button>
          <button className="pipeline-play" onClick={() => { if (step === STEPS.length - 1) setStep(0); setPlaying((value) => !value); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Pause" : "Ablauf abspielen"}</button>
          <button className="secondary-button" onClick={() => { setPlaying(false); setStep((value) => Math.min(STEPS.length - 1, value + 1)); }} disabled={step === STEPS.length - 1}>Weiter <ChevronRight size={16} /></button>
        </footer>
      </section>
    </div>
  );
}

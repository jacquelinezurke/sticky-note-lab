"use client";

import {
  BrainCircuit, Check, ChevronLeft, ChevronRight, Crop, GitMerge, Image as ImageIcon,
  Layers3, Pause, PencilRuler, Play, ScanLine, SlidersHorizontal, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { OcrRunDiagnostics } from "./ocr-engine";
import type { OcrEvidence } from "./text-correction";

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
  ocrEvidence?: OcrEvidence[];
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

type VisualCandidate = OcrEvidence & { simulated?: boolean };

function normalizedText(value: string) {
  return value.toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function textAgreement(left: string, right: string) {
  const normalizedLeft = normalizedText(left);
  const normalizedRight = normalizedText(right);
  const longest = Math.max(1, normalizedLeft.length, normalizedRight.length);
  return Math.round(clamp((1 - editDistance(normalizedLeft, normalizedRight) / longest) * 100, 0, 100));
}

function simulatedCandidate(text: string, engine: OcrEvidence["engine"], confidence: number): VisualCandidate {
  const substitutions: Record<OcrEvidence["engine"], Array<[RegExp, string]>> = {
    paddle: [[/o/i, "0"], [/i/i, "l"]],
    dehtr: [[/rn/i, "m"], [/\s+/g, " "]],
    tesseract: [[/l/i, "1"], [/s/i, "5"]],
  };
  let candidate = text || "Handschrift";
  for (const [pattern, replacement] of substitutions[engine]) {
    if (pattern.test(candidate)) { candidate = candidate.replace(pattern, replacement); break; }
  }
  return { text: candidate, confidence: clamp(confidence, 35, 94), engine, variant: "Simulation", scope: "note", simulated: true };
}

function engineCandidates(note: PipelineNote | undefined): VisualCandidate[] {
  const real = note?.ocrEvidence?.filter((entry) => entry.text.trim()) ?? [];
  if (real.length) {
    return (["paddle", "dehtr", "tesseract"] as const).flatMap((engine) => {
      const candidates = real.filter((entry) => entry.engine === engine)
        .sort((left, right) => Number(right.scope === "note") - Number(left.scope === "note") || right.confidence - left.confidence);
      return candidates.slice(0, 2);
    });
  }
  const text = note?.rawText?.trim() || note?.text?.trim() || "Weniger Schritte bis zum Ergebnis";
  const confidence = note?.confidence || 78;
  return [
    simulatedCandidate(text, "paddle", confidence + 5),
    simulatedCandidate(text, "dehtr", confidence - 1),
    simulatedCandidate(text, "tesseract", confidence - 8),
  ];
}

function CandidateTokens({ candidate, finalText }: { candidate: VisualCandidate; finalText: string }) {
  const finalWords = normalizedText(finalText).split(" ");
  return <p className="pipeline-token-row">{candidate.text.split(/(\s+)/).map((token, index) => {
    if (!token.trim()) return <span key={index}>{token}</span>;
    const normalized = normalizedText(token);
    const agrees = finalWords.includes(normalized);
    return <mark key={`${token}-${index}`} className={agrees ? "agrees" : "uncertain"}>{token}</mark>;
  })}</p>;
}

function NotePicker({ notes, value, onChange }: { notes: PipelineNote[]; value: string; onChange: (id: string) => void }) {
  if (notes.length < 2) return null;
  return <label className="pipeline-note-picker"><span>Notiz analysieren</span><select value={value} onChange={(event) => onChange(event.target.value)}>{notes.map((note, index) => <option key={note.id} value={note.id}>#{index + 1} · {(note.text || "ohne Text").replace(/\s+/g, " ").slice(0, 32)}</option>)}</select></label>;
}

export function PipelineVisualization({
  open, onClose, imageSrc, fileName, notes, diagnostics, isAnalyzing, analysisProgress,
}: PipelineVisualizationProps) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [focusedNoteId, setFocusedNoteId] = useState("");
  const current = STEPS[step];
  const activeNote = useMemo(() => notes.find((note) => note.id === focusedNoteId) ?? notes.find((note) => note.text.trim()) ?? notes[0], [focusedNoteId, notes]);

  useEffect(() => {
    if (!open || !playing) return;
    const timer = window.setTimeout(() => setStep((value) => {
      if (value >= STEPS.length - 1) {
        setPlaying(false);
        return value;
      }
      return value + 1;
    }), step === 5 || step === 6 ? 4200 : 2100);
    return () => window.clearTimeout(timer);
  }, [open, playing, step]);

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
  const candidates = engineCandidates(activeNote);
  const primaryCandidates = (["paddle", "dehtr", "tesseract"] as const).map((engine) => candidates.find((candidate) => candidate.engine === engine)
    ?? simulatedCandidate(finalText, engine, (activeNote?.confidence || 76) - 5));
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
          {step === 5 && <StageFrame label="OCR-Labor · echte Evidenz nach einem Scan, sonst markierte Simulation"><NotePicker notes={notes} value={activeNote?.id ?? ""} onChange={setFocusedNoteId} /><div className="pipeline-ocr-lab"><div className="pipeline-line-detection"><div className="pipeline-ocr-crop" style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}<div className="pipeline-text-lines">{Array.from({ length: clamp((rawText.match(/\n/g)?.length ?? 0) + 1, 1, 5) }, (_, index) => <i key={index} style={{ top: `${20 + index * 16}%`, width: `${82 - index % 2 * 13}%` }}><span /></i>)}</div><div className="pipeline-reading-beam" /></div><div className="pipeline-line-caption"><ScanLine size={14} /><span>Zeilen werden einzeln und als Gesamtblock gelesen</span></div></div><div className="pipeline-engine-streams">{primaryCandidates.map((candidate, index) => {
              const names = ["PaddleOCR", "DE·HTR", "Tesseract"];
              const engine = engineRows?.[index]?.[1];
              return <div key={candidate.engine} className={`pipeline-engine-stream engine-${candidate.engine}`}><div className="pipeline-engine-head"><span>{names[index]}</span><small>{candidate.simulated ? "SIMULATION" : `${candidate.scope === "note" ? "GANZE NOTIZ" : `ZEILE ${(candidate.lineIndex ?? 0) + 1}`} · ECHT`}</small><strong>{candidate.confidence}%</strong></div><CandidateTokens candidate={candidate} finalText={finalText} /><div className="pipeline-confidence-track"><i style={{ width: `${candidate.confidence}%` }} /></div><div className="pipeline-engine-meta"><span>{candidate.variant || (index === 0 ? "RGB + Filter" : index === 1 ? "Handschriftmodell" : "Fallback")}</span><span>{engine ? `${engine.candidateCount} Kandidaten gesamt` : "Beispiellesart"}</span></div></div>;
            })}<div className="pipeline-stream-pulses"><i /><i /><i /></div></div></div></StageFrame>}
          {step === 6 && <StageFrame label="Konsens-Labor · vereinfachte, nachvollziehbare Darstellung der echten Auswahlkriterien"><NotePicker notes={notes} value={activeNote?.id ?? ""} onChange={setFocusedNoteId} /><div className="pipeline-consensus-lab"><div className="pipeline-vote-lanes">{primaryCandidates.map((candidate, index) => {
              const agreement = textAgreement(candidate.text, finalText);
              const completeness = Math.round(clamp(normalizedText(candidate.text).length / Math.max(1, normalizedText(finalText).length) * 100, 0, 100));
              return <div key={candidate.engine} className={`pipeline-vote engine-${candidate.engine}`}><div className="pipeline-vote-source"><span>{["Paddle", "DE·HTR", "Tesseract"][index]}</span><small>{candidate.simulated ? "simuliert" : "gemessen"}</small></div><p>{candidate.text}</p><div className="pipeline-vote-metrics"><span><i style={{ width: `${candidate.confidence}%` }} />Konfidenz {candidate.confidence}%</span><span><i style={{ width: `${agreement}%` }} />Textnähe {agreement}%</span><span><i style={{ width: `${completeness}%` }} />Vollständig {completeness}%</span></div><div className="pipeline-vote-packet" style={{ animationDelay: `${index * .42}s` }} /></div>;
            })}</div><div className="pipeline-fusion-core"><span><GitMerge size={24} /></span><strong>EVIDENCE<br />FUSION</strong><small>unabhängige Leser<br />schlagen Wiederholungen</small></div><div className="pipeline-final-note" style={{ background: activeNote?.color ?? "#f7dc68" }}><span>GEWÄHLTER TEXT</span><p>{finalText}</p><strong>{activeNote?.confidence ?? 0}%</strong></div></div><div className="pipeline-decision-strip"><span>{new Set(primaryCandidates.filter((candidate) => !candidate.simulated).map((candidate) => candidate.engine)).size || 3} Leserpfade</span><span>ganze Notiz bevorzugt</span><span>{activeNote?.corrections?.length ?? 0} sichere Korrekturen</span></div>{!!activeNote?.corrections?.length && <div className="pipeline-corrections">{activeNote.corrections.slice(0, 4).map((correction, index) => <span key={`${correction.from}-${index}`}><del>{correction.from}</del> → <b>{correction.to}</b></span>)}</div>}</StageFrame>}
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

"use client";

import {
  BrainCircuit, Check, ChevronLeft, ChevronRight, Crop, GitMerge, Image as ImageIcon,
  Layers3, Pause, PencilRuler, Play, ScanLine, SlidersHorizontal, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { hexToRgb, rgbToLab, stickyPaletteDistance, STICKY_NOTE_PALETTE } from "./note-color";
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

function visualHex(value: string | undefined) {
  const hex = value?.trim().replace(/^#/u, "") ?? "";
  if (/^[0-9a-f]{3}$/iu.test(hex)) return `#${hex.split("").map((digit) => digit + digit).join("")}`;
  return /^[0-9a-f]{6}$/iu.test(hex) ? `#${hex}` : "#f7dc68";
}

const COLOR_NAMES: Record<string, string> = {
  "#f7dc68": "Gelb", "#f2a3b4": "Rosa", "#a9d9ee": "Blau", "#b9dfa5": "Grün",
  "#cdb8ee": "Lila", "#f2b46d": "Orange", "#f6f0df": "Creme", "#d6d8db": "Grau",
};

function ColorLabExplorer({ notes, activeNote }: { notes: PipelineNote[]; activeNote: PipelineNote | undefined }) {
  const groups = [...notes.reduce((map, note) => {
    const color = visualHex(note.color).toLowerCase();
    const current = map.get(color) ?? { color, count: 0, lab: rgbToLab(hexToRgb(color)) };
    current.count += 1;
    map.set(color, current);
    return map;
  }, new Map<string, { color: string; count: number; lab: [number, number, number] }>()).values()];
  const selectedColor = visualHex(activeNote?.color).toLowerCase();
  const selectedLab = rgbToLab(hexToRgb(selectedColor));
  const paletteDistances = STICKY_NOTE_PALETTE.map((color) => ({
    color,
    name: COLOR_NAMES[color] ?? color,
    distance: stickyPaletteDistance(selectedLab, rgbToLab(hexToRgb(color))),
  })).sort((left, right) => left.distance - right.distance).slice(0, 4);
  const chartX = (a: number) => 190 + clamp(a, -70, 70) * 2.05;
  const chartY = (b: number) => 119 - clamp(b, -70, 70) * 1.45;
  return <div className="pipeline-color-lab">
    <div className="pipeline-lab-chart">
      <svg viewBox="0 0 380 240" role="img" aria-labelledby="lab-chart-title lab-chart-description">
        <title id="lab-chart-title">Erkannte Farbgruppen im CIELAB-Farbraum</title>
        <desc id="lab-chart-description">Die horizontale Achse zeigt Grün bis Rot, die vertikale Blau bis Gelb. Große markierte Punkte sind Farbzentren der erkannten Post-its.</desc>
        <defs>
          <linearGradient id="lab-horizontal" x1="0" x2="1"><stop offset="0" stopColor="#74b98a" stopOpacity=".18" /><stop offset=".5" stopColor="#fff" stopOpacity=".06" /><stop offset="1" stopColor="#dc7184" stopOpacity=".2" /></linearGradient>
          <linearGradient id="lab-vertical" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#628fd3" stopOpacity=".16" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#eed85f" stopOpacity=".2" /></linearGradient>
        </defs>
        <rect x="42" y="16" width="326" height="196" rx="8" fill="url(#lab-horizontal)" className="pipeline-chart-frame" />
        <rect x="42" y="16" width="326" height="196" rx="8" fill="url(#lab-vertical)" />
        {[81, 120, 159, 198, 237, 276, 315].map((x) => <line key={`x-${x}`} x1={x} x2={x} y1="16" y2="212" className="pipeline-chart-grid" />)}
        {[48, 83, 118, 153, 188].map((y) => <line key={`y-${y}`} x1="42" x2="368" y1={y} y2={y} className="pipeline-chart-grid" />)}
        <line x1="42" x2="368" y1="119" y2="119" className="pipeline-chart-axis" />
        <line x1="190" x2="190" y1="16" y2="212" className="pipeline-chart-axis" />
        <text x="42" y="231" className="pipeline-axis-label">−a* grün</text><text x="368" y="231" textAnchor="end" className="pipeline-axis-label">+a* rot</text>
        <text x="34" y="26" textAnchor="end" className="pipeline-axis-label">+b* gelb</text><text x="34" y="210" textAnchor="end" className="pipeline-axis-label">−b* blau</text>
        {groups.flatMap((group, groupIndex) => Array.from({ length: 7 }, (_, sampleIndex) => {
          const angle = sampleIndex * 2.31 + groupIndex * .77;
          const radius = 4 + (sampleIndex % 3) * 3;
          return <circle key={`${group.color}-${sampleIndex}`} cx={chartX(group.lab[1]) + Math.cos(angle) * radius} cy={chartY(group.lab[2]) + Math.sin(angle) * radius} r="2.4" fill={group.color} className="pipeline-lab-sample" style={{ animationDelay: `${groupIndex * .08 + sampleIndex * .045}s` }} />;
        }))}
        {groups.map((group) => {
          const selected = group.color === selectedColor;
          return <g key={group.color} className={selected ? "pipeline-lab-centroid selected" : "pipeline-lab-centroid"}>
            <circle cx={chartX(group.lab[1])} cy={chartY(group.lab[2])} r={selected ? 10 : 8} fill={group.color} />
            <circle cx={chartX(group.lab[1])} cy={chartY(group.lab[2])} r={selected ? 14 : 11} fill="none" />
            <text x={chartX(group.lab[1]) + 13} y={chartY(group.lab[2]) - 10}>{group.count}×</text>
          </g>;
        })}
      </svg>
      <div className="pipeline-lab-coordinates"><span style={{ background: selectedColor }} /><b>{COLOR_NAMES[selectedColor] ?? selectedColor}</b><code>L* {selectedLab[0].toFixed(1)} · a* {selectedLab[1].toFixed(1)} · b* {selectedLab[2].toFixed(1)}</code></div>
    </div>
    <div className="pipeline-palette-distance">
      <div><strong>Zuordnung zur Zielpalette</strong><small>Wahrnehmungsabstand · kleiner ist ähnlicher</small></div>
      {paletteDistances.map((entry, index) => <div className={index === 0 ? "winner" : ""} key={entry.color}>
        <span style={{ background: entry.color }} /><b>{entry.name}</b><i><em style={{ width: `${clamp(100 - entry.distance * 2.1, 5, 100)}%` }} /></i><code>Δ {entry.distance.toFixed(1)}</code>
      </div>)}
      <p><span /> Innenpixel werden robust gemittelt; schwarze Tinte, Schatten und Überlappungen zählen als Ausreißer.</p>
    </div>
  </div>;
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

function DetailSwitch<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void; label: string }) {
  return <div className="pipeline-detail-switch" role="group" aria-label={label}>{options.map(([id, text]) => <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>)}</div>;
}

const OCR_VARIANTS = [
  { id: "rgb", label: "RGB", matches: (value: string) => /-rgb$/u.test(value) },
  { id: "contrast", label: "Kontrast", matches: (value: string) => /contrast/u.test(value) && !/line/u.test(value) },
  { id: "gray", label: "Grau", matches: (value: string) => /gray/u.test(value) },
  { id: "sauvola", label: "Sauvola", matches: (value: string) => /sauvola/u.test(value) },
  { id: "ink", label: "Tinte", matches: (value: string) => /-ink$/u.test(value) },
  { id: "line", label: "Zeilen", matches: (value: string) => /line/u.test(value) },
] as const;

function OcrVariantMatrix({ evidence, primary }: { evidence: VisualCandidate[]; primary: VisualCandidate[] }) {
  const hasMeasured = evidence.some((candidate) => !candidate.simulated);
  const supported: Record<OcrEvidence["engine"], Set<string>> = {
    paddle: new Set(["rgb", "contrast", "gray", "sauvola", "ink", "line"]),
    dehtr: new Set(["rgb", "contrast", "line"]),
    tesseract: new Set(["contrast", "sauvola"]),
  };
  const names: Record<OcrEvidence["engine"], string> = { paddle: "PaddleOCR", dehtr: "DE·HTR", tesseract: "Tesseract" };
  const engines = ["paddle", "dehtr", "tesseract"] as const;
  return <div className="pipeline-matrix-wrap">
    <div className="pipeline-variant-note"><span>Schattenausgleich</span><i />wird vor Kontrast/CLAHE angewendet und ist deshalb keine eigene OCR-Abstimmung.</div>
    <div className="pipeline-ocr-matrix" role="table" aria-label="OCR-Varianten nach Leser">
      <div className="corner" role="columnheader">Leser × Crop</div>{OCR_VARIANTS.map((variant) => <div key={variant.id} className="column-head" role="columnheader">{variant.label}</div>)}
      {engines.flatMap((engine, engineIndex) => {
        const base = primary.find((candidate) => candidate.engine === engine)?.confidence ?? 70;
        return [<div key={`${engine}-name`} className={`row-head engine-${engine}`} role="rowheader"><i />{names[engine]}</div>, ...OCR_VARIANTS.map((variant, variantIndex) => {
          const measured = evidence.filter((candidate) => candidate.engine === engine && variant.matches((candidate.variant ?? "").toLowerCase())).sort((left, right) => right.confidence - left.confidence)[0];
          const simulated = !hasMeasured && supported[engine].has(variant.id);
          const score = measured?.confidence ?? (simulated ? clamp(base - variantIndex * 3 - engineIndex * 2, 38, 96) : null);
          return <div key={`${engine}-${variant.id}`} className={`matrix-cell engine-${engine} ${simulated ? "simulated" : ""} ${score === null ? "inactive" : ""}`} role="cell" aria-label={`${names[engine]} ${variant.label}: ${score === null ? "nicht ausgeführt" : `${score} Prozent`}`}>
            {score === null ? <span>—</span> : <><strong>{score}</strong><small>%</small><i style={{ height: `${score}%` }} /></>}
          </div>;
        })];
      })}
    </div>
    <div className="pipeline-matrix-legend"><span><i className="measured" /> gemessener Lauf</span><span><i className={hasMeasured ? "missing" : "simulated"} /> {hasMeasured ? "nicht benötigt/ausgeführt" : "markierte Simulation"}</span></div>
  </div>;
}

function EvidenceScatter({ evidence, finalText }: { evidence: VisualCandidate[]; finalText: string }) {
  const points = evidence.slice(0, 24).map((candidate, index) => ({
    ...candidate,
    index,
    completeness: Math.round(clamp(normalizedText(candidate.text).length / Math.max(1, normalizedText(finalText).length) * 100, 0, 100)),
    agreement: textAgreement(candidate.text, finalText),
  }));
  const x = (value: number) => 48 + clamp(value, 0, 100) * 3.05;
  const y = (value: number) => 216 - clamp(value, 0, 100) * 1.72;
  return <div className="pipeline-evidence-scatter">
    <svg viewBox="0 0 380 250" role="img" aria-labelledby="evidence-title evidence-description">
      <title id="evidence-title">OCR-Kandidaten nach Konfidenz und Vollständigkeit</title>
      <desc id="evidence-description">Jeder Punkt ist eine Lesart. Rechts bedeutet höhere Modellkonfidenz, oben bedeutet vollständigeren Text. Die Ringgröße zeigt die Übereinstimmung mit dem gewählten Ergebnis.</desc>
      <rect x="48" y="24" width="305" height="192" rx="8" className="pipeline-chart-frame" />
      {[0, 25, 50, 75, 100].map((value) => <g key={`x-${value}`}><line x1={x(value)} x2={x(value)} y1="24" y2="216" className="pipeline-chart-grid" /><text x={x(value)} y="234" textAnchor="middle" className="pipeline-axis-label">{value}</text></g>)}
      {[0, 25, 50, 75, 100].map((value) => <g key={`y-${value}`}><line x1="48" x2="353" y1={y(value)} y2={y(value)} className="pipeline-chart-grid" /><text x="40" y={y(value) + 4} textAnchor="end" className="pipeline-axis-label">{value}</text></g>)}
      <text x="201" y="248" textAnchor="middle" className="pipeline-axis-title">Modellkonfidenz (%)</text>
      <text x="12" y="120" textAnchor="middle" transform="rotate(-90 12 120)" className="pipeline-axis-title">Vollständigkeit (%)</text>
      <path d="M261 58 L342 58 L342 25" className="pipeline-target-zone" />
      <text x="347" y="18" textAnchor="end" className="pipeline-target-label">starke vollständige Kandidaten</text>
      {points.map((point) => <g key={`${point.engine}-${point.variant}-${point.index}`} className={`pipeline-evidence-point engine-${point.engine} ${point.simulated ? "simulated" : ""}`}>
        <circle cx={x(point.confidence)} cy={y(point.completeness)} r={5 + point.agreement / 24} />
        <circle cx={x(point.confidence)} cy={y(point.completeness)} r="3.2" />
        <title>{`${point.engine} · ${point.variant} · ${point.confidence}% Konfidenz · ${point.completeness}% vollständig · ${point.agreement}% Textnähe`}</title>
      </g>)}
    </svg>
    <div className="pipeline-scatter-legend"><span className="engine-paddle"><i /> Paddle</span><span className="engine-dehtr"><i /> DE·HTR</span><span className="engine-tesseract"><i /> Tesseract</span><small>Ring = Textnähe zum Ergebnis</small></div>
  </div>;
}

function FallbackGraph({ diagnostics }: { diagnostics: OcrRunDiagnostics | null }) {
  const simulated = !diagnostics;
  const fallbackActive = simulated || diagnostics.tesseract.status !== "skipped";
  const status = (engine: keyof Pick<OcrRunDiagnostics, "paddle" | "dehtr" | "tesseract">) => diagnostics?.[engine].status ?? "simulation";
  const detail = (engine: keyof Pick<OcrRunDiagnostics, "paddle" | "dehtr" | "tesseract">) => {
    const value = diagnostics?.[engine];
    if (!value) return "Beispielpfad";
    if (value.status === "skipped") return "nicht benötigt";
    return `${value.candidateCount} Kandidaten · ${(value.elapsedMs / 1000).toFixed(1)} s`;
  };
  const node = (x: number, y: number, width: number, title: string, engine?: "paddle" | "dehtr" | "tesseract") => <g className={`pipeline-fallback-node ${engine ? `status-${status(engine)}` : "neutral"}`} transform={`translate(${x} ${y})`}>
    <rect width={width} height="54" rx="9" />
    {engine && <circle cx="13" cy="14" r="4" />}
    <text x={engine ? 23 : width / 2} y="19" textAnchor={engine ? "start" : "middle"} className="title">{title}</text>
    <text x={width / 2} y="39" textAnchor="middle" className="detail">{engine ? detail(engine) : title === "Qualitäts-Gate" ? "Text · Konfidenz · Lexikon" : title === "Evidenzfusion" ? "Konsens · Vollständigkeit" : "entzerrt + gefiltert"}</text>
  </g>;
  return <div className="pipeline-fallback-wrap">
    <svg viewBox="0 0 850 285" role="img" aria-labelledby="fallback-title fallback-description">
      <title id="fallback-title">Entscheidungsgraph der OCR-Fallbacks</title>
      <desc id="fallback-description">PaddleOCR liest zuerst, DE HTR ergänzt Handschrift. Ein Qualitäts-Gate schaltet Tesseract nur bei schwacher Evidenz hinzu. Danach werden alle verfügbaren Kandidaten fusioniert.</desc>
      <defs><marker id="fallback-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
      <path d="M120 112 H150" className="pipeline-flow active" markerEnd="url(#fallback-arrow)" />
      <path d="M280 112 H310" className="pipeline-flow active" markerEnd="url(#fallback-arrow)" />
      <path d="M440 112 H470" className="pipeline-flow active" markerEnd="url(#fallback-arrow)" />
      <path d="M590 112 H700" className={`pipeline-flow ${fallbackActive ? "inactive" : "active"}`} markerEnd="url(#fallback-arrow)" />
      <path d="M530 139 C530 184 565 209 610 209" className={`pipeline-flow fallback ${fallbackActive ? "active" : "inactive"}`} markerEnd="url(#fallback-arrow)" />
      <path d="M740 209 C776 209 780 166 760 139" className={`pipeline-flow fallback ${fallbackActive ? "active" : "inactive"}`} markerEnd="url(#fallback-arrow)" />
      {node(20, 85, 100, "Notiz-Crop")}{node(150, 85, 130, "PaddleOCR", "paddle")}{node(310, 85, 130, "DE·HTR", "dehtr")}{node(470, 85, 120, "Qualitäts-Gate")}{node(610, 182, 130, "Tesseract", "tesseract")}{node(700, 85, 130, "Evidenzfusion")}
      <text x="534" y="158" textAnchor="middle" className="pipeline-fallback-condition">schwach?</text>
      <text x="645" y="99" textAnchor="middle" className="pipeline-fallback-condition">gut genug</text>
      <g className="pipeline-fallback-rule" transform="translate(196 248)"><rect width="458" height="27" rx="6" /><text x="229" y="18" textAnchor="middle">Tesseract startet bei: kein Text · Konfidenz &lt; 70% · Qualität &lt; 45 · Lexikonplausibilität &lt; 0,5</text></g>
    </svg>
    <div className="pipeline-fallback-mobile">
      <div><b>1</b><span>Notiz-Crop</span><small>entzerrt + gefiltert</small></div><i>↓</i>
      <div className={`status-${status("paddle")}`}><b>2</b><span>PaddleOCR</span><small>{detail("paddle")}</small></div><i>↓</i>
      <div className={`status-${status("dehtr")}`}><b>3</b><span>DE·HTR</span><small>{detail("dehtr")}</small></div><i>↓</i>
      <div><b>4</b><span>Qualitäts-Gate</span><small>kein Text · &lt;70% · Qualität &lt;45 · Lexikon &lt;0,5</small></div><i>↓</i>
      <div className={`status-${status("tesseract")}`}><b>5</b><span>{fallbackActive ? "Tesseract übernimmt als Fallback" : "Tesseract wird übersprungen"}</span><small>{detail("tesseract")}</small></div><i>↓</i>
      <div><b>6</b><span>Evidenzfusion</span><small>alle verfügbaren unabhängigen Lesarten</small></div>
    </div>
    <div className="pipeline-fallback-legend"><span><i className="ready" />bereit</span><span><i className="partial" />teilweise</span><span><i className="failed" />ausgefallen</span><span><i className="skipped" />übersprungen</span>{simulated && <small>Simulation – nach einem Scan werden echte Status und Laufzeiten gezeigt.</small>}</div>
  </div>;
}

export function PipelineVisualization({
  open, onClose, imageSrc, fileName, notes, diagnostics, isAnalyzing, analysisProgress,
}: PipelineVisualizationProps) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [focusedNoteId, setFocusedNoteId] = useState("");
  const [ocrView, setOcrView] = useState<"readers" | "matrix" | "scatter">("readers");
  const [consensusView, setConsensusView] = useState<"fusion" | "fallback">("fusion");
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
  const measuredEvidence = activeNote?.ocrEvidence?.filter((candidate) => candidate.text.trim()) ?? [];
  const detailCandidates: VisualCandidate[] = measuredEvidence.length ? measuredEvidence : primaryCandidates;
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
          {step === 1 && <StageFrame label="CIELAB · robuste Innenpixel · wahrnehmungsnahe Palette"><NotePicker notes={notes} value={activeNote?.id ?? ""} onChange={setFocusedNoteId} /><ColorLabExplorer notes={notes} activeNote={activeNote} /></StageFrame>}
          {step === 2 && <StageFrame label="Connected Components + Kantenmodell"><MiniBoard imageSrc={imageSrc} notes={notes} mode="geometry" /><div className="pipeline-facts"><span>{notes.length} Kandidaten</span><span>4 Ecken je Zettel</span><span>Z-Reihenfolge</span></div></StageFrame>}
          {step === 3 && <StageFrame label="Projektive Transformation"><div className="pipeline-transform"><div><small>im Foto</small><div className="pipeline-crop skewed" style={{ ...cropBackground(imageSrc, activeNote), transform: `rotate(${activeNote?.rotation ?? -8}deg)` }}>{!imageSrc && <b>{rawText}</b>}</div></div><ChevronRight size={26} /><div><small>entzerrt</small><div className="pipeline-crop straight" style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}</div></div></div></StageFrame>}
          {step === 4 && <StageFrame label="Mehrfachvorverarbeitung desselben Original-Crops"><div className="pipeline-filter-grid">{[
            ["RGB", "rgb"], ["Graustufen", "gray"], ["Schattenausgleich", "shadow"], ["Kontrast", "contrast"], ["Sauvola S/W", "sauvola"], ["Nur Tinte", "ink"],
          ].map(([label, variant]) => <div key={variant}><span>{label}</span><div className={`pipeline-filter pipeline-filter-${variant}`} style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}</div></div>)}</div></StageFrame>}
          {step === 5 && <StageFrame label="OCR-Labor · echte Evidenz nach einem Scan, sonst markierte Simulation"><NotePicker notes={notes} value={activeNote?.id ?? ""} onChange={setFocusedNoteId} /><DetailSwitch value={ocrView} onChange={setOcrView} label="OCR-Detailansicht" options={[["readers", "Leser"], ["matrix", "Varianten-Matrix"], ["scatter", "Kandidaten-Graph"]]} />{ocrView === "readers" && <div className="pipeline-ocr-lab"><div className="pipeline-line-detection"><div className="pipeline-ocr-crop" style={cropBackground(imageSrc, activeNote)}>{!imageSrc && <b>{rawText}</b>}<div className="pipeline-text-lines">{Array.from({ length: clamp((rawText.match(/\n/g)?.length ?? 0) + 1, 1, 5) }, (_, index) => <i key={index} style={{ top: `${20 + index * 16}%`, width: `${82 - index % 2 * 13}%` }}><span /></i>)}</div><div className="pipeline-reading-beam" /></div><div className="pipeline-line-caption"><ScanLine size={14} /><span>Zeilen werden einzeln und als Gesamtblock gelesen</span></div></div><div className="pipeline-engine-streams">{primaryCandidates.map((candidate, index) => {
              const names = ["PaddleOCR", "DE·HTR", "Tesseract"];
              const engine = engineRows?.[index]?.[1];
              return <div key={candidate.engine} className={`pipeline-engine-stream engine-${candidate.engine}`}><div className="pipeline-engine-head"><span>{names[index]}</span><small>{candidate.simulated ? "SIMULATION" : `${candidate.scope === "note" ? "GANZE NOTIZ" : `ZEILE ${(candidate.lineIndex ?? 0) + 1}`} · ECHT`}</small><strong>{candidate.confidence}%</strong></div><CandidateTokens candidate={candidate} finalText={finalText} /><div className="pipeline-confidence-track"><i style={{ width: `${candidate.confidence}%` }} /></div><div className="pipeline-engine-meta"><span>{candidate.variant || (index === 0 ? "RGB + Filter" : index === 1 ? "Handschriftmodell" : "Fallback")}</span><span>{engine ? `${engine.candidateCount} Kandidaten gesamt` : "Beispiellesart"}</span></div></div>;
            })}<div className="pipeline-stream-pulses"><i /><i /><i /></div></div></div>}{ocrView === "matrix" && <OcrVariantMatrix evidence={detailCandidates} primary={primaryCandidates} />}{ocrView === "scatter" && <EvidenceScatter evidence={detailCandidates} finalText={finalText} />}</StageFrame>}
          {step === 6 && <StageFrame label="Konsens-Labor · Fallback-Orchestrierung · Evidenzfusion"><NotePicker notes={notes} value={activeNote?.id ?? ""} onChange={setFocusedNoteId} /><DetailSwitch value={consensusView} onChange={setConsensusView} label="Konsens-Detailansicht" options={[["fusion", "Konsens"], ["fallback", "Fallback-Graph"]]} />{consensusView === "fusion" && <><div className="pipeline-consensus-lab"><div className="pipeline-vote-lanes">{primaryCandidates.map((candidate, index) => {
              const agreement = textAgreement(candidate.text, finalText);
              const completeness = Math.round(clamp(normalizedText(candidate.text).length / Math.max(1, normalizedText(finalText).length) * 100, 0, 100));
              return <div key={candidate.engine} className={`pipeline-vote engine-${candidate.engine}`}><div className="pipeline-vote-source"><span>{["Paddle", "DE·HTR", "Tesseract"][index]}</span><small>{candidate.simulated ? "simuliert" : "gemessen"}</small></div><p>{candidate.text}</p><div className="pipeline-vote-metrics"><span><i style={{ width: `${candidate.confidence}%` }} />Konfidenz {candidate.confidence}%</span><span><i style={{ width: `${agreement}%` }} />Textnähe {agreement}%</span><span><i style={{ width: `${completeness}%` }} />Vollständig {completeness}%</span></div><div className="pipeline-vote-packet" style={{ animationDelay: `${index * .42}s` }} /></div>;
            })}</div><div className="pipeline-fusion-core"><span><GitMerge size={24} /></span><strong>EVIDENCE<br />FUSION</strong><small>unabhängige Leser<br />schlagen Wiederholungen</small></div><div className="pipeline-final-note" style={{ background: activeNote?.color ?? "#f7dc68" }}><span>GEWÄHLTER TEXT</span><p>{finalText}</p><strong>{activeNote?.confidence ?? 0}%</strong></div></div><div className="pipeline-decision-strip"><span>{new Set(primaryCandidates.filter((candidate) => !candidate.simulated).map((candidate) => candidate.engine)).size || 3} Leserpfade</span><span>ganze Notiz bevorzugt</span><span>{activeNote?.corrections?.length ?? 0} sichere Korrekturen</span></div>{!!activeNote?.corrections?.length && <div className="pipeline-corrections">{activeNote.corrections.slice(0, 4).map((correction, index) => <span key={`${correction.from}-${index}`}><del>{correction.from}</del> → <b>{correction.to}</b></span>)}</div>}</>}{consensusView === "fallback" && <FallbackGraph diagnostics={diagnostics} />}</StageFrame>}
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

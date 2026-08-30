import type { OcrEvidence } from "./text-correction";

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Keeps complete-note evidence diverse and bounds line evidence per line. */
export function mergeOcrEvidence(current: OcrEvidence[], incoming: OcrEvidence) {
  const next = [...current];
  const duplicate = next.findIndex((entry) => normalized(entry.text) === normalized(incoming.text)
    && entry.scope === incoming.scope
    && entry.lineIndex === incoming.lineIndex
    && entry.engine === incoming.engine
    && entry.variant === incoming.variant);
  if (duplicate >= 0) {
    if (incoming.confidence > next[duplicate].confidence) next[duplicate] = incoming;
  } else {
    next.push(incoming);
  }

  const retainDiverseReadings = (entries: OcrEvidence[], limit: number) => {
    const distinct = new Map<string, OcrEvidence>();
    for (const entry of entries) {
      const key = normalized(entry.text);
      const existing = distinct.get(key);
      const measured = entry.variant !== "selected" && !entry.variant?.includes("fusion");
      const existingMeasured = existing && existing.variant !== "selected" && !existing.variant?.includes("fusion");
      if (!existing || measured && !existingMeasured || measured === existingMeasured && entry.confidence > existing.confidence) {
        distinct.set(key, entry);
      }
    }
    const representative = (entry: OcrEvidence) => entry.variant === "selected"
      || Boolean(entry.variant?.includes("fusion"))
      || Boolean(entry.variant?.includes("aggregate"));
    return [...distinct.values()]
      .sort((left, right) => Number(representative(right)) - Number(representative(left)) || right.confidence - left.confidence)
      .slice(0, limit);
  };

  const notes: OcrEvidence[] = [];
  const noteEntries = next.filter((entry) => entry.scope === "note");
  for (const engine of [...new Set(noteEntries.map((entry) => entry.engine))]) {
    notes.push(...retainDiverseReadings(noteEntries.filter((entry) => entry.engine === engine), 4));
  }
  const lines = next.filter((entry) => entry.scope === "line");
  const boundedLines: OcrEvidence[] = [];
  const indexes = [...new Set(lines.map((entry) => entry.lineIndex ?? -1))];
  for (const lineIndex of indexes) {
    const group = lines.filter((entry) => (entry.lineIndex ?? -1) === lineIndex);
    for (const engine of [...new Set(group.map((entry) => entry.engine))]) {
      boundedLines.push(...retainDiverseReadings(group.filter((entry) => entry.engine === engine), 2));
    }
  }
  return [...notes, ...boundedLines];
}

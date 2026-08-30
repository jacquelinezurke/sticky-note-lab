export type OcrEngineName = "paddle" | "dehtr" | "tesseract";

export type FusionCandidate = {
  engine: OcrEngineName;
  variant: string;
  text: string;
  confidence: number;
};

export type FusionLexicon = {
  isKnown: (word: string) => boolean;
};

export type FusionContext = {
  expectedLineCount?: number;
  expectedCharacters?: number;
};

export type FusedOcrCandidate = FusionCandidate & {
  agreement: number;
  supportingEngines: number;
  quality: number;
  needsReview: boolean;
};

type LineOption = {
  candidate: FusionCandidate;
  line: string;
};

const WORD_PATTERN = /[\p{L}][\p{L}'’-]*/gu;
const JUNK_PATTERN = /[^\p{L}\p{N}\s.,:;!?()/&+%#@-]/gu;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function usableOcrLines(text: string) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
}

function normalizedLine(line: string) {
  return line.toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]/gu, "");
}

export function ocrTextSimilarity(left: string, right: string) {
  const a = normalizedLine(left);
  const b = normalizedLine(right);
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function intrinsicLineScore(option: LineOption, lexicon: FusionLexicon) {
  const words = option.line.match(WORD_PATTERN) ?? [];
  if (!words.length) return -8;
  const knownRatio = words.filter((word) => lexicon.isKnown(word)).length / words.length;
  const junk = option.line.match(JUNK_PATTERN)?.length ?? 0;
  const junkRatio = junk / Math.max(1, option.line.length);
  // A dictionary is only a soft tie-breaker. Visual agreement must beat a plausible
  // but wrongly read real word such as "older" versus "order".
  return knownRatio * 0.38 - junkRatio * 2.6
    + clamp(option.candidate.confidence, 0, 100) / 100 * 0.1
    + Math.min(words.length, 6) * 0.035;
}

const VALID_SHORT_LABELS = new Set(["ai", "api", "hr", "it", "qa", "ui", "ux"]);

export function assessOcrText(candidate: FusionCandidate, lexicon: FusionLexicon, context: FusionContext = {}) {
  const lines = usableOcrLines(candidate.text);
  const words = candidate.text.match(WORD_PATTERN) ?? [];
  if (!lines.length || !words.length) return 0;
  const normalizedWords = words.map((word) => word.toLocaleLowerCase("de-DE"));
  const knownRatio = normalizedWords.filter((word) => lexicon.isKnown(word)).length / words.length;
  const characters = normalizedLine(candidate.text).length;
  const junkRatio = (candidate.text.match(JUNK_PATTERN)?.length ?? 0) / Math.max(1, candidate.text.length);
  const shortRatio = normalizedWords.filter((word) => word.length <= 2 && !VALID_SHORT_LABELS.has(word)).length / words.length;
  const vowellessRatio = normalizedWords.filter((word) => word.length >= 5 && !/[aeiouyäöü]/u.test(word)).length / words.length;
  const expectedCharacters = Math.max(1, context.expectedCharacters ?? Math.min(8, Math.max(4, characters)));
  const characterCoverage = clamp(characters / expectedCharacters, 0, 1);
  const expectedLines = Math.max(1, context.expectedLineCount ?? lines.length);
  const lineCoverage = clamp(lines.length / expectedLines, 0, 1);
  const quality = 0.26
    + knownRatio * 0.2
    + characterCoverage * 0.2
    + lineCoverage * 0.1
    + clamp(candidate.confidence, 0, 100) / 100 * 0.08
    + clamp(characters / 8, 0, 1) * 0.12
    - shortRatio * 0.24
    - vowellessRatio * 0.16
    - junkRatio * 0.45;
  return clamp(quality, 0, 1);
}

export function collapseEngineVariants(candidates: FusionCandidate[], lexicon: FusionLexicon, context: FusionContext = {}) {
  const usable = candidates.filter((candidate) => usableOcrLines(candidate.text).length > 0);
  const inferredContext: FusionContext = {
    expectedLineCount: context.expectedLineCount ?? Math.max(1, ...usable.map((candidate) => usableOcrLines(candidate.text).length)),
    expectedCharacters: context.expectedCharacters ?? Math.max(1, ...usable.map((candidate) => normalizedLine(candidate.text).length)),
  };
  const engines = [...new Set(usable.map((candidate) => candidate.engine))];
  return engines.map((engine) => {
    const group = usable.filter((candidate) => candidate.engine === engine);
    return [...group].sort((left, right) => {
      const score = (candidate: FusionCandidate) => {
        const sameEngine = Math.max(0, ...group.filter((peer) => peer !== candidate).map((peer) => ocrTextSimilarity(candidate.text, peer.text)));
        const crossEngine = Math.max(0, ...usable.filter((peer) => peer.engine !== engine).map((peer) => ocrTextSimilarity(candidate.text, peer.text)));
        return assessOcrText(candidate, lexicon, inferredContext) * 2.4 + sameEngine * 0.55 + crossEngine * 2
          + Math.min(usableOcrLines(candidate.text).length, 6) * 0.06
          + clamp(normalizedLine(candidate.text).length / Math.max(1, inferredContext.expectedCharacters ?? 1), 0, 1) * 0.16;
      };
      return score(right) - score(left);
    })[0];
  });
}

function alignToAnchor(anchor: string[], incoming: string[]) {
  const gap = -0.9;
  const scores = Array.from({ length: anchor.length + 1 }, () => new Array<number>(incoming.length + 1).fill(0));
  const moves = Array.from({ length: anchor.length + 1 }, () => new Array<"diag" | "up" | "left" | null>(incoming.length + 1).fill(null));
  for (let row = 1; row <= anchor.length; row += 1) { scores[row][0] = row * gap; moves[row][0] = "up"; }
  for (let column = 1; column <= incoming.length; column += 1) { scores[0][column] = column * gap; moves[0][column] = "left"; }
  for (let row = 1; row <= anchor.length; row += 1) {
    for (let column = 1; column <= incoming.length; column += 1) {
      const agreement = ocrTextSimilarity(anchor[row - 1], incoming[column - 1]);
      const diagonal = agreement >= 0.25 ? scores[row - 1][column - 1] + agreement * 3 - 1 : Number.NEGATIVE_INFINITY;
      const up = scores[row - 1][column] + gap;
      const left = scores[row][column - 1] + gap;
      if (diagonal >= up && diagonal >= left) { scores[row][column] = diagonal; moves[row][column] = "diag"; }
      else if (up >= left) { scores[row][column] = up; moves[row][column] = "up"; }
      else { scores[row][column] = left; moves[row][column] = "left"; }
    }
  }

  const aligned = new Map<number, string>();
  let row = anchor.length;
  let column = incoming.length;
  while (row > 0 || column > 0) {
    const move = moves[row][column];
    if (move === "diag") {
      if (ocrTextSimilarity(anchor[row - 1], incoming[column - 1]) >= 0.25) aligned.set(row - 1, incoming[column - 1]);
      row -= 1;
      column -= 1;
    } else if (move === "up") row -= 1;
    else column -= 1;
  }
  return aligned;
}

function documentScore(candidate: FusionCandidate, all: FusionCandidate[], lexicon: FusionLexicon, context: FusionContext) {
  const lines = usableOcrLines(candidate.text);
  return lines.reduce((sum, line) => {
    let support = 0;
    let crossEngineSupport = 0;
    for (const peer of all) {
      if (peer === candidate) continue;
      for (const peerLine of usableOcrLines(peer.text)) {
        const similarity = ocrTextSimilarity(line, peerLine);
        support = Math.max(support, similarity);
        if (peer.engine !== candidate.engine) crossEngineSupport = Math.max(crossEngineSupport, similarity);
      }
    }
    return sum + intrinsicLineScore({ candidate, line }, lexicon) + support * 1.2 + crossEngineSupport * 0.7;
  }, assessOcrText(candidate, lexicon, context) * 3 + Math.min(lines.length, context.expectedLineCount ?? lines.length) * 0.04);
}

/**
 * Fuses only complete note readings. Every output line is copied verbatim from a
 * recognizer; this function never invents or spell-corrects text.
 */
export function fuseOcrLines(candidates: FusionCandidate[], lexicon: FusionLexicon, context: FusionContext = {}): FusedOcrCandidate | null {
  const collapsed = collapseEngineVariants(candidates, lexicon, context);
  const usable = collapsed
    .map((candidate) => ({ ...candidate, confidence: clamp(candidate.confidence, 0, 100), lines: usableOcrLines(candidate.text) }))
    .filter((candidate) => candidate.lines.length > 0);
  if (!usable.length) return null;

  const anchor = [...usable].sort((left, right) => {
    const delta = documentScore(right, usable, lexicon, context) - documentScore(left, usable, lexicon, context);
    return Math.abs(delta) > 0.001 ? delta : right.lines.length - left.lines.length;
  })[0];
  const slots: LineOption[][] = anchor.lines.map((line) => [{ candidate: anchor, line }]);
  for (const candidate of usable) {
    if (candidate === anchor) continue;
    const aligned = alignToAnchor(anchor.lines, candidate.lines);
    if (!aligned.size && anchor.lines.length === candidate.lines.length) {
      candidate.lines.forEach((line, index) => aligned.set(index, line));
    }
    aligned.forEach((line, index) => slots[index].push({ candidate, line }));
  }

  const selectedAll = slots.map((options) => [...options].sort((left, right) => {
    const score = (option: LineOption) => {
      const peers = options.filter((peer) => peer !== option);
      const consensus = peers.length
        ? peers.reduce((sum, peer) => sum + ocrTextSimilarity(option.line, peer.line), 0) / peers.length
        : 0;
      const crossEngine = Math.max(0, ...peers.filter((peer) => peer.candidate.engine !== option.candidate.engine)
        .map((peer) => ocrTextSimilarity(option.line, peer.line)));
      return intrinsicLineScore(option, lexicon) + assessOcrText(option.candidate, lexicon, context) * 1.8
        + consensus * 1.4 + crossEngine * 0.75;
    };
    return score(right) - score(left);
  })[0]);
  const selectedIndexes = selectedAll
    .map((option, index) => ({ option, index }))
    .filter(({ option, index }) => {
      const normalized = normalizedLine(option.line);
      if (normalized.length !== 1 || VALID_SHORT_LABELS.has(normalized)) return true;
      return slots[index].some((peer) => peer !== option
        && peer.candidate.engine !== option.candidate.engine
        && ocrTextSimilarity(option.line, peer.line) >= 0.8);
    })
    .map(({ index }) => index);
  const selected = (selectedIndexes.length ? selectedIndexes : selectedAll.map((_, index) => index))
    .map((index) => selectedAll[index]);
  const text = selected.map((option) => option.line).join("\n").trim();
  if (!text) return null;
  const agreement = selected.reduce((sum, option, index) => {
    const slotIndex = selectedIndexes.length ? selectedIndexes[index] : index;
    const peers = slots[slotIndex].filter((peer) => peer !== option);
    const best = Math.max(0, ...peers.map((peer) => ocrTextSimilarity(option.line, peer.line)));
    return sum + best;
  }, 0) / Math.max(1, selected.length);
  const rawConfidence = selected.reduce((sum, option) => sum + option.candidate.confidence, 0) / selected.length;
  const engines = new Set(selected.map((option) => option.candidate.engine));
  const supportingEngines = new Set(usable.filter((candidate) => selected.some((option) => usableOcrLines(candidate.text)
    .some((line) => ocrTextSimilarity(option.line, line) >= 0.35)))
    .map((candidate) => candidate.engine)).size;
  const quality = selected.reduce((sum, option) => sum + assessOcrText(option.candidate, lexicon, context), 0) / selected.length;
  const confidence = Math.round(supportingEngines >= 2 && agreement >= 0.6
    ? clamp(38 + agreement * 38 + quality * 18, 35, 96)
    : clamp(18 + quality * 48 + rawConfidence * 0.18, 15, 82));
  return {
    text,
    confidence,
    engine: engines.size === 1 ? selected[0].candidate.engine : anchor.engine,
    variant: engines.size > 1 ? "cross-engine-fusion" : "variant-fusion",
    agreement,
    supportingEngines,
    quality,
    needsReview: supportingEngines < 2 || agreement < 0.55 || quality < 0.62,
  };
}

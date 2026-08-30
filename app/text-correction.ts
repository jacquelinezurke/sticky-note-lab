"use client";

import nspell from "nspell";

export type TextCorrection = {
  from: string;
  to: string;
  start: number;
  end: number;
  kind: "case" | "spelling" | "rescue" | "spacing";
  automatic: boolean;
};

export type OcrEvidence = {
  text: string;
  confidence: number;
  engine: "paddle" | "dehtr" | "tesseract";
  variant?: string;
  scope: "note" | "line";
  lineIndex?: number;
};

export type CorrectedText = {
  rawText: string;
  text: string;
  corrections: TextCorrection[];
};

type Speller = ReturnType<typeof nspell>;
type SpellerPair = { de: Speller; en: Speller };
type PreferredLanguage = keyof SpellerPair | null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const TEXT_DECODER = new TextDecoder("utf-8");
// Keeping the hyphen escaped makes the mixed Unicode word class unambiguous.
// eslint-disable-next-line no-useless-escape
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
const PROTECTED_TERMS = new Set([
  "ai", "api", "app", "backend", "brainstorming", "chatgpt", "codex", "figma", "frontend",
  "html", "kanban", "kpi", "miro", "mockup", "ocr", "pdf", "postit", "postits", "ppt",
  "seo", "slack", "ui", "url", "ux",
]);

const OCR_SUBSTITUTION_COST = new Map([
  ["0:o", 0.16], ["o:0", 0.16], ["q:o", 0.22], ["o:q", 0.22],
  ["1:i", 0.18], ["i:1", 0.18], ["1:l", 0.18], ["l:1", 0.18],
  ["i:l", 0.22], ["l:i", 0.22], ["5:s", 0.24], ["s:5", 0.24],
  ["8:b", 0.26], ["b:8", 0.26], ["d:b", 0.34], ["b:d", 0.34],
  ["u:v", 0.42], ["v:u", 0.42], ["e:o", 0.52], ["o:e", 0.52],
  ["a:l", 0.54], ["l:a", 0.54],
]);

const OCR_TRANSITIONS = [
  { from: "rn", to: "m", cost: 0.34 }, { from: "m", to: "rn", cost: 0.34 },
  { from: "cl", to: "d", cost: 0.38 }, { from: "d", to: "cl", cost: 0.38 },
  { from: "vv", to: "w", cost: 0.4 }, { from: "w", to: "vv", cost: 0.4 },
];

const DIGIT_CONFUSABLES: Record<string, string[]> = {
  "0": ["o"], "1": ["i", "l"], "5": ["s"], "8": ["b"],
};

let spellersPromise: Promise<SpellerPair> | null = null;

function loadDictionary(path: string) {
  return fetch(path).then(async (response) => {
    if (!response.ok) throw new Error(`Wörterbuch ${path} konnte nicht geladen werden.`);
    return TEXT_DECODER.decode(await response.arrayBuffer());
  });
}

async function getSpellers() {
  if (!spellersPromise) {
    spellersPromise = Promise.all([
      loadDictionary("/dictionaries/de.aff"),
      loadDictionary("/dictionaries/de.dic"),
      loadDictionary("/dictionaries/en.aff"),
      loadDictionary("/dictionaries/en.dic"),
    ]).then(([deAff, deDic, enAff, enDic]) => ({
      de: nspell(deAff, deDic),
      en: nspell(enAff, enDic),
    })).catch((error) => {
      spellersPromise = null;
      throw error;
    });
  }
  return spellersPromise;
}

export async function getOcrWordChecker() {
  const spellers = await getSpellers();
  return (word: string) => {
    const lower = word.toLocaleLowerCase("de-DE");
    return PROTECTED_TERMS.has(lower) || spellers.de.correct(word) || spellers.en.correct(word)
      || spellers.de.correct(lower) || spellers.en.correct(lower);
  };
}

function isAllCaps(word: string) {
  return word.length > 1 && word === word.toLocaleUpperCase("de-DE");
}

function hasMixedInternalCase(word: string) {
  return /\p{Ll}/u.test(word.slice(1)) && /\p{Lu}/u.test(word.slice(1));
}

function looksLikeAllCaps(word: string) {
  const letters = [...word].filter((character) => /\p{L}/u.test(character));
  if (letters.length <= 1) return false;
  const uppercaseCount = letters.filter((character) => character === character.toLocaleUpperCase("de-DE")).length;
  return isAllCaps(word)
    || (/^\p{Lu}/u.test(word) && /\p{Lu}$/u.test(word) && uppercaseCount / letters.length >= 0.5);
}

function preserveCase(source: string, replacement: string) {
  if (looksLikeAllCaps(source)) return replacement.toLocaleUpperCase("de-DE");
  if (/^\p{Lu}/u.test(source)) return replacement.charAt(0).toLocaleUpperCase("de-DE") + replacement.slice(1).toLocaleLowerCase("de-DE");
  return replacement.toLocaleLowerCase("de-DE");
}

function editDistance(left: string, right: string): number {
  const a = left.toLocaleLowerCase("de-DE");
  const b = right.toLocaleLowerCase("de-DE");
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) rows[row][0] = row;
  for (let column = 0; column <= b.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = rows[row - 1][column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, substitution);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

function weightedOcrDistance(left: string, right: string) {
  const a = [...left.normalize("NFKC").toLocaleLowerCase("de-DE")];
  const b = [...right.normalize("NFKC").toLocaleLowerCase("de-DE")];
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(Number.POSITIVE_INFINITY));
  rows[0][0] = 0;
  for (let row = 0; row <= a.length; row += 1) {
    for (let column = 0; column <= b.length; column += 1) {
      const current = rows[row][column];
      if (!Number.isFinite(current)) continue;
      if (row < a.length) rows[row + 1][column] = Math.min(rows[row + 1][column], current + 0.85);
      if (column < b.length) {
        rows[row][column + 1] = Math.min(rows[row][column + 1], current + 0.85);
      }
      if (row < a.length && column < b.length) {
        const key = `${a[row]}:${b[column]}`;
        rows[row + 1][column + 1] = Math.min(rows[row + 1][column + 1], current + (a[row] === b[column] ? 0 : OCR_SUBSTITUTION_COST.get(key) ?? 1));
      }
      if (row + 1 < a.length && column + 1 < b.length && a[row] === b[column + 1] && a[row + 1] === b[column]) {
        rows[row + 2][column + 2] = Math.min(rows[row + 2][column + 2], current + 0.45);
      }
      for (const transition of OCR_TRANSITIONS) {
        const from = [...transition.from];
        const to = [...transition.to];
        if (a.slice(row, row + from.length).join("") === transition.from && b.slice(column, column + to.length).join("") === transition.to) {
          rows[row + from.length][column + to.length] = Math.min(rows[row + from.length][column + to.length], current + transition.cost);
        }
      }
    }
  }
  return rows[a.length][b.length];
}

function normalizeComparable(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function textSimilarity(left: string, right: string) {
  const a = normalizeComparable(left).replace(/ /g, "");
  const b = normalizeComparable(right).replace(/ /g, "");
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function wordStats(value: string, spellers: SpellerPair, boardVocabulary: Set<string>) {
  const words = [...value.matchAll(WORD_PATTERN)].map((match) => match[0]);
  const known = words.filter((word) => {
    const lower = word.toLocaleLowerCase("de-DE");
    return PROTECTED_TERMS.has(lower) || boardVocabulary.has(lower) || spellers.de.correct(word) || spellers.en.correct(word)
      || spellers.de.correct(lower) || spellers.en.correct(lower);
  }).length;
  const junk = value.match(/[^\p{L}\p{N}\s.,:;!?()\-/&+%#@]/gu)?.length ?? 0;
  return { words, knownRatio: words.length ? known / words.length : 0, junkRatio: junk / Math.max(1, value.length) };
}

function digitVariants(word: string, limit = 32) {
  let values = [""];
  for (const character of word) {
    values = values.flatMap((prefix) => [character, ...(DIGIT_CONFUSABLES[character] ?? [])].map((next) => prefix + next)).slice(0, limit);
  }
  return values.slice(1);
}

function chooseObservedText(
  primary: OcrEvidence,
  alternatives: OcrEvidence[],
  spellers: SpellerPair,
  boardVocabulary: Set<string>,
  preferredLanguage: PreferredLanguage,
) {
  const observed = [primary, ...alternatives.filter((entry) => entry.scope === "note")]
    .filter((entry) => entry.text.trim())
    .filter((entry, index, all) => all.findIndex((other) => normalizeComparable(other.text) === normalizeComparable(entry.text)
      && other.engine === entry.engine && other.variant === entry.variant && other.scope === entry.scope) === index);
  if (observed.length < 2) return primary;

  const exactGroups = new Map<string, OcrEvidence[]>();
  for (const entry of observed) {
    const key = normalizeComparable(entry.text);
    exactGroups.set(key, [...(exactGroups.get(key) ?? []), entry]);
  }
  const consensus = [...exactGroups.values()].map((entries) => {
    const measured = entries.filter((entry) => entry.variant !== "selected" && !entry.variant?.includes("fusion"));
    const sources = measured.length ? measured : entries;
    const sourceCount = new Set(sources.map((entry) => `${entry.engine}:${entry.variant ?? "default"}`)).size;
    const engineCount = new Set(sources.map((entry) => entry.engine)).size;
    const confidence = sources.reduce((sum, entry) => sum + clamp(entry.confidence, 0, 100), 0) / sources.length;
    const representative = [...entries].sort((left, right) => right.confidence - left.confidence)[0];
    return { representative, sourceCount, engineCount, confidence };
  }).sort((left, right) => right.engineCount - left.engineCount || right.sourceCount - left.sourceCount || right.confidence - left.confidence);
  const strongest = consensus[0];
  const runnerUp = consensus[1];
  const independentlyConfirmed = strongest && strongest.engineCount >= 2;
  const clearVote = !runnerUp || strongest.engineCount > runnerUp.engineCount
    || strongest.engineCount === runnerUp.engineCount && strongest.sourceCount > runnerUp.sourceCount;
  if (independentlyConfirmed && clearVote && normalizeComparable(strongest.representative.text) !== normalizeComparable(primary.text)) {
    return strongest.representative;
  }

  const score = (entry: OcrEvidence) => {
    const stats = wordStats(entry.text, spellers, boardVocabulary);
    const crossEnginePeers = observed.filter((peer) => peer.engine !== entry.engine);
    const crossEngine = Math.max(0, ...crossEnginePeers.map((peer) => textSimilarity(entry.text, peer.text)));
    const domainCoverage = stats.words.length
      ? stats.words.filter((word) => PROTECTED_TERMS.has(word.toLocaleLowerCase("de-DE")) || boardVocabulary.has(word.toLocaleLowerCase("de-DE"))).length / stats.words.length
      : 0;
    const recoverableCoverage = stats.words.length
      ? stats.words.filter((word) => safeAllCapsSuggestion(word, spellers, boardVocabulary, preferredLanguage)).length / stats.words.length
      : 0;
    return stats.knownRatio * 0.45 + recoverableCoverage * 0.65 + domainCoverage * 0.45 + crossEngine * 1.75
      + clamp(entry.confidence, 0, 100) / 100 * 0.3 - stats.junkRatio * 2.2;
  };
  const ranked = [...observed].sort((left, right) => score(right) - score(left));
  const winner = ranked[0];
  const primaryScore = score(primary);
  const winnerCrossEngine = Math.max(0, ...observed.filter((peer) => peer.engine !== winner.engine).map((peer) => textSimilarity(winner.text, peer.text)));
  const winnerStats = wordStats(winner.text, spellers, boardVocabulary);
  const hasSafeRescue = winnerStats.words.some((word) => safeAllCapsSuggestion(word, spellers, boardVocabulary, preferredLanguage));
  return winner !== primary && score(winner) - primaryScore >= (hasSafeRescue ? 0.01 : 0.45) && winnerCrossEngine >= 0.55
    ? winner
    : primary;
}

function suggestionScore(source: string, suggestion: string, rank: number, boardVocabulary: Set<string>) {
  const distance = editDistance(source, suggestion);
  const ocrDistance = weightedOcrDistance(source, suggestion);
  const lengthDelta = Math.abs(source.length - suggestion.length);
  const prefixBonus = source[0]?.toLocaleLowerCase("de-DE") === suggestion[0]?.toLocaleLowerCase("de-DE") ? 0.4 : 0;
  const lower = suggestion.toLocaleLowerCase("de-DE");
  const protectedBonus = PROTECTED_TERMS.has(lower) ? 0.85 : boardVocabulary.has(lower) ? 0.55 : 0;
  return ocrDistance * 0.76 + distance * 0.24 + lengthDelta * 0.08 + rank * 0.025 - prefixBonus - protectedBonus;
}

function uniqueSuggestions(spellers: SpellerPair, word: string, boardVocabulary: Set<string>, preferredLanguage: PreferredLanguage = null) {
  const domainSuggestions = [...new Set([...PROTECTED_TERMS, ...boardVocabulary])].filter((term) => {
    const maxDistance = word.length >= 8 ? 3 : 2;
    return Math.abs(term.length - word.length) <= 2 && editDistance(word, term) <= maxDistance
      && weightedOcrDistance(word, term) <= Math.max(1.25, word.length * 0.22);
  });
  const languageSuggestions = preferredLanguage
    ? [spellers[preferredLanguage], spellers[preferredLanguage === "de" ? "en" : "de"]]
    : [spellers.de, spellers.en];
  const suggestions = [...domainSuggestions, ...languageSuggestions.flatMap((speller) => speller.suggest(word).slice(0, 12))];
  return [...new Map(suggestions.map((value) => [value.toLocaleLowerCase("de-DE"), value])).values()];
}

function safeAllCapsSuggestion(
  word: string,
  spellers: SpellerPair,
  boardVocabulary: Set<string>,
  preferredLanguage: PreferredLanguage = null,
) {
  if (word.length < 5 || !isAllCaps(word)) return null;
  const lower = word.toLocaleLowerCase("de-DE");
  if (spellers.de.correct(word) || spellers.en.correct(word) || spellers.de.correct(lower) || spellers.en.correct(lower)) return null;
  const source = word.toLocaleLowerCase("de-DE");
  const ranked = uniqueSuggestions(spellers, word, boardVocabulary, preferredLanguage)
    .map((suggestion, rank) => ({
      suggestion,
      score: suggestionScore(word, suggestion, rank, boardVocabulary)
        + (preferredLanguage && !spellers[preferredLanguage].correct(suggestion) ? 0.65 : 0),
      distance: editDistance(word, suggestion),
      normalizedCost: weightedOcrDistance(word, suggestion) / Math.max(1, word.length),
    }))
    .filter(({ suggestion }) => {
      const normalized = suggestion.toLocaleLowerCase("de-DE");
      const adjacentTransposition = normalized.length === source.length && [...source].some((_, index) => index + 1 < source.length
        && source.slice(0, index) === normalized.slice(0, index)
        && source[index] === normalized[index + 1]
        && source[index + 1] === normalized[index]
        && source.slice(index + 2) === normalized.slice(index + 2));
      return !adjacentTransposition
        && (normalized.startsWith(source) || normalized.endsWith(source) || normalized.length === source.length);
    })
    .sort((left, right) => left.score - right.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.distance !== 1 || best.normalizedCost > 0.18 || second && second.score - best.score < 0.04) return null;
  return best.suggestion;
}

function correctOneText(
  rawText: string,
  spellers: SpellerPair,
  boardVocabulary: Set<string>,
  preferredLanguage: PreferredLanguage,
): CorrectedText {
  const corrections: TextCorrection[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const match of rawText.matchAll(WORD_PATTERN)) {
    const word = match[0];
    const start = match.index;
    const lower = word.toLocaleLowerCase("de-DE");
    const dictionaryCorrect = spellers.de.correct(word) || spellers.en.correct(word) || spellers.de.correct(lower) || spellers.en.correct(lower);
    const hasConfusableDigits = /[0158]/u.test(word) && /\p{L}/u.test(word);
    const protectedWord = /\d/u.test(word) && !hasConfusableDigits;

    const mixedDigitWord = /\d/u.test(word) && /\p{L}/u.test(word);
    if ((dictionaryCorrect && !mixedDigitWord) || PROTECTED_TERMS.has(lower) || boardVocabulary.has(lower)) {
      if (hasMixedInternalCase(word) && (spellers.de.correct(lower) || spellers.en.correct(lower) || PROTECTED_TERMS.has(lower))) {
        const allTextCaps = isAllCaps(rawText.replace(/[^\p{L}]/gu, ""));
        const replacement = looksLikeAllCaps(word) || allTextCaps
          ? lower.toLocaleUpperCase("de-DE")
          : /^\p{Lu}/u.test(word) ? lower.charAt(0).toLocaleUpperCase("de-DE") + lower.slice(1) : lower;
        if (replacement !== word) {
          replacements.push({ start, end: start + word.length, value: replacement });
          corrections.push({ from: word, to: replacement, start, end: start + word.length, kind: "case", automatic: true });
        }
      }
      continue;
    }
    if (protectedWord) continue;

    if (hasConfusableDigits) {
      const valid = [...new Map(digitVariants(word)
        .filter((candidate) => {
          const candidateLower = candidate.toLocaleLowerCase("de-DE");
          return PROTECTED_TERMS.has(candidateLower) || boardVocabulary.has(candidateLower)
            || spellers.de.correct(candidateLower) || spellers.en.correct(candidateLower);
        })
        .map((candidate) => [candidate.toLocaleLowerCase("de-DE"), candidate])).values()];
      if (valid.length === 1) {
        const replacement = preserveCase(word, valid[0]);
        replacements.push({ start, end: start + word.length, value: replacement });
        corrections.push({ from: word, to: replacement, start, end: start + word.length, kind: "rescue", automatic: true });
      }
      continue;
    }

    const ranked = uniqueSuggestions(spellers, word, boardVocabulary, preferredLanguage)
      .map((suggestion, rank) => ({
        suggestion,
        score: suggestionScore(word, suggestion, rank, boardVocabulary),
        distance: editDistance(word, suggestion),
        ocrDistance: weightedOcrDistance(word, suggestion),
        domain: PROTECTED_TERMS.has(suggestion.toLocaleLowerCase("de-DE")) || boardVocabulary.has(suggestion.toLocaleLowerCase("de-DE")),
      }))
      .sort((a, b) => a.score - b.score);
    const best = ranked[0];
    const second = ranked[1];
    if (!best) continue;
    const maxDistance = word.length >= 8 ? 3 : word.length >= 6 ? 2 : 1;
    const normalizedCost = best.ocrDistance / Math.max(1, word.length);
    const clearLead = !second || second.score - best.score >= (best.domain ? 0.28 : 0.5);
    const protectedLead = !second || !PROTECTED_TERMS.has(second.suggestion.toLocaleLowerCase("de-DE"))
      || second.score - best.score >= 0.18;
    const obviousGlyphRescue = hasConfusableDigits && best.ocrDistance <= 0.65 && clearLead;
    const bestLower = best.suggestion.toLocaleLowerCase("de-DE");
    const explicitDomain = PROTECTED_TERMS.has(bestLower);
    const capsLike = looksLikeAllCaps(word);
    const highValueDomain = boardVocabulary.has(bestLower) && (capsLike || best.ocrDistance <= 0.72);
    const ambiguousMixedCase = !capsLike && best.distance <= 1 && best.ocrDistance > 0.3;
    const safeDomainRescue = !ambiguousMixedCase && highValueDomain && best.distance <= maxDistance && normalizedCost <= 0.2
      && (clearLead || (explicitDomain && capsLike && (protectedLead || best.ocrDistance <= 0.9)));
    const safeCapsRescue = safeAllCapsSuggestion(word, spellers, boardVocabulary, preferredLanguage);
    if (!obviousGlyphRescue && !safeDomainRescue && !safeCapsRescue) continue;
    const replacement = preserveCase(word, safeCapsRescue ?? best.suggestion);
    if (replacement.toLocaleLowerCase("de-DE") === lower) continue;
    replacements.push({ start, end: start + word.length, value: replacement });
    corrections.push({ from: word, to: replacement, start, end: start + word.length, kind: "rescue", automatic: true });
  }

  let text = rawText;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
  }
  return { rawText, text, corrections };
}

export async function correctOcrTexts<T extends {
  id: string;
  text: string;
  confidence: number;
  engine?: "paddle" | "dehtr" | "tesseract" | "none";
  alternatives?: OcrEvidence[];
}>(
  items: T[],
  report: (completed: number, total: number) => void,
) {
  const spellers = await getSpellers();
  let germanOnly = 0;
  let englishOnly = 0;
  for (const item of items) for (const match of item.text.matchAll(WORD_PATTERN)) {
    if (match[0].length < 3) continue;
    const german = spellers.de.correct(match[0]) || spellers.de.correct(match[0].toLocaleLowerCase("de-DE"));
    const english = spellers.en.correct(match[0]) || spellers.en.correct(match[0].toLocaleLowerCase("de-DE"));
    if (german && !english) germanOnly += 1;
    if (english && !german) englishOnly += 1;
  }
  const preferredLanguage: PreferredLanguage = englishOnly >= germanOnly + 2 ? "en" : germanOnly >= englishOnly + 2 ? "de" : null;
  const boardVocabulary = new Set(PROTECTED_TERMS);
  const vocabularyEvidence = new Map<string, { noteIds: Set<string>; sources: Set<string>; engines: Set<string> }>();
  for (const item of items) {
    const primaryEngine = item.engine && item.engine !== "none" ? item.engine : "paddle";
    const evidence: OcrEvidence[] = [
      { text: item.text, confidence: item.confidence, engine: primaryEngine, variant: "selected", scope: "note" },
      ...(item.alternatives ?? []).filter((entry) => entry.scope === "note"),
    ];
    for (const entry of evidence) for (const match of entry.text.matchAll(WORD_PATTERN)) {
      const lower = match[0].toLocaleLowerCase("de-DE");
      if (lower.length < 4 || PROTECTED_TERMS.has(lower)
        || spellers.de.correct(match[0]) || spellers.en.correct(match[0])
        || spellers.de.correct(lower) || spellers.en.correct(lower)) continue;
      const current = vocabularyEvidence.get(lower) ?? { noteIds: new Set<string>(), sources: new Set<string>(), engines: new Set<string>() };
      current.noteIds.add(item.id);
      current.sources.add(`${entry.engine}:${entry.variant ?? "default"}`);
      current.engines.add(entry.engine);
      vocabularyEvidence.set(lower, current);
    }
  }
  for (const [word, evidence] of vocabularyEvidence) {
    const nearDictionaryWord = [...spellers.de.suggest(word).slice(0, 8), ...spellers.en.suggest(word).slice(0, 8)]
      .some((suggestion) => editDistance(word, suggestion) <= 1);
    if (evidence.noteIds.size >= 2 || evidence.engines.size >= 2 && evidence.sources.size >= 2 && !nearDictionaryWord) {
      boardVocabulary.add(word);
    }
  }

  return items.map((item, index) => {
    const primaryEngine = item.engine && item.engine !== "none"
      ? item.engine
      : item.alternatives?.find((entry) => entry.scope === "note")?.engine ?? "paddle";
    const primary: OcrEvidence = {
      text: item.text.normalize("NFC"),
      confidence: item.confidence,
      engine: primaryEngine,
      variant: "selected",
      scope: "note",
    };
    const observed = chooseObservedText(primary, item.alternatives ?? [], spellers, boardVocabulary, preferredLanguage);
    const corrected = correctOneText(observed.text.normalize("NFC"), spellers, boardVocabulary, preferredLanguage);
    const observedCorrection: TextCorrection[] = observed.text !== primary.text ? [{
      from: primary.text,
      to: observed.text,
      start: 0,
      end: primary.text.length,
      kind: "rescue",
      automatic: true,
    }] : [];
    const corrections = [...observedCorrection, ...corrected.corrections];
    report(index + 1, items.length);
    const publicItem = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "alternatives")) as Omit<T, "alternatives">;
    return {
      ...publicItem,
      rawText: primary.text,
      text: corrected.text,
      corrections,
      confidence: Math.min(observed.text !== primary.text ? 82 : 99, Math.max(0, observed.confidence - corrections.length * 4)),
    };
  });
}

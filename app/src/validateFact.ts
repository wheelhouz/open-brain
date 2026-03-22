import type { FactCandidate } from "./facts.js";
import { normalizePredicate, isValidPredicateShape } from "./facts.js";

export interface ValidationResult {
  valid: boolean;
  flagged: boolean;
  reasons: string[];
  containingLine: string | null;
}

/**
 * Normalize text for fuzzy excerpt matching: collapse whitespace,
 * normalize quotes and dashes, lowercase.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, (c) =>
      c === "\u2018" || c === "\u2019" ? "'" : '"',
    )
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find excerpt position in source content.
 * Returns { found, position, normalized } where normalized indicates
 * whether only the normalized fallback matched.
 */
export function findExcerptInSource(
  excerpt: string,
  sourceContent: string,
): { found: boolean; position: number; normalized: boolean } {
  if (!excerpt) return { found: false, position: -1, normalized: false };

  // Tier 1: exact substring
  const exactPos = sourceContent.indexOf(excerpt);
  if (exactPos !== -1) return { found: true, position: exactPos, normalized: false };

  // Tier 2: normalized fallback
  const normExcerpt = normalizeText(excerpt);
  const normSource = normalizeText(sourceContent);
  const normPos = normSource.indexOf(normExcerpt);
  if (normPos !== -1) {
    // Map normalized position back to approximate original position
    // (good enough for line detection)
    const ratio = normPos / Math.max(normSource.length, 1);
    const approxPos = Math.round(ratio * sourceContent.length);
    return { found: true, position: approxPos, normalized: true };
  }

  return { found: false, position: -1, normalized: false };
}

/**
 * Extract the line (or bullet item) containing the given position.
 * Falls back to ±150 char window for single-line content.
 */
export function extractContainingLine(
  sourceContent: string,
  position: number,
): string {
  const lines = sourceContent.split("\n");

  if (lines.length > 1) {
    let offset = 0;
    for (const line of lines) {
      if (position >= offset && position < offset + line.length + 1) {
        // Strip bullet markers for cleaner matching
        return line.replace(/^[\s]*[-*•]\s+/, "").trim();
      }
      offset += line.length + 1; // +1 for \n
    }
    // Fallback to last line
    return lines[lines.length - 1].replace(/^[\s]*[-*•]\s+/, "").trim();
  }

  // Single line: use ±150 char window
  const start = Math.max(0, position - 150);
  const end = Math.min(sourceContent.length, position + 150);
  return sourceContent.slice(start, end).trim();
}

// Patterns indicating the excerpt is in speculative/question context
const QUESTION_STARTERS =
  /^(do|does|did|is|are|was|were|can|could|should|would|might|wonder|wondering)\b/i;
const UNCERTAINTY_PHRASES = [
  "need to ask",
  "wondering if",
  "wondering whether",
  "not sure if",
  "not sure whether",
  "i think",
  "i believe",
  "maybe",
  "possibly",
  "might",
  "probably",
];

/**
 * Check if the excerpt appears in speculative/uncertain context.
 */
export function hasSpeculativeContext(
  containingLine: string,
  excerptPosition: number,
): boolean {
  // Question framing: line ends with ?
  if (containingLine.trimEnd().endsWith("?")) return true;

  // Line starts with question word
  if (QUESTION_STARTERS.test(containingLine.trim())) return true;

  // Conditional: "if" or "whether" appears before the excerpt position in the line
  const beforeExcerpt = containingLine.slice(0, excerptPosition).toLowerCase();
  if (/\bif\b/.test(beforeExcerpt) || /\bwhether\b/.test(beforeExcerpt)) return true;

  // Uncertainty phrases anywhere in the containing line
  const lineLower = containingLine.toLowerCase();
  for (const phrase of UNCERTAINTY_PHRASES) {
    if (lineLower.includes(phrase)) return true;
  }

  return false;
}

// Event patterns that indicate one-time activities
const EVENT_PATTERNS = [
  "had lunch",
  "had coffee",
  "had dinner",
  "had a meeting",
  "had a call",
  "met with",
  "met up with",
  "talked to",
  "talked with",
  "ran into",
  "caught up with",
  "call with",
  "meeting with",
  "emailed",
  "called",
];

/**
 * Check if the excerpt is within an event-only context.
 * Uses positional heuristic: if event pattern starts the line and
 * the excerpt overlaps with the event phrase, reject.
 */
export function hasEventOnlyContext(
  containingLine: string,
  excerpt: string,
): boolean {
  const lineLower = containingLine.toLowerCase();
  const excerptLower = excerpt.toLowerCase();

  for (const pattern of EVENT_PATTERNS) {
    if (!lineLower.startsWith(pattern)) continue;

    // Find where the excerpt starts in the line
    const excerptPos = lineLower.indexOf(excerptLower);
    if (excerptPos === -1) continue;

    // If excerpt starts within or before the event phrase ends, it's event-only
    // Add some buffer for the entity name after the event phrase
    // e.g., "Had coffee with Maya" — "Maya" is part of the event frame
    const patternEnd = pattern.length;

    // Find the next clause boundary after the event pattern
    // Look for punctuation, conjunctions that start new clauses
    const afterPattern = lineLower.slice(patternEnd);
    const clauseBreak = afterPattern.search(/[.;]|\b(and|but|from|who|she|he|they)\b/);

    if (clauseBreak === -1) {
      // No clause break found — entire line is the event frame
      return true;
    }

    const breakPos = patternEnd + clauseBreak;
    if (excerptPos < breakPos) {
      return true;
    }

    // Excerpt starts after the clause break — it's in a separate clause
    return false;
  }

  return false;
}

// Strong temporal markers — not bare "was"/"worked"
const TEMPORAL_MARKERS = [
  "used to",
  "formerly",
  "previously",
  "no longer",
];
const TEMPORAL_UNTIL = /\buntil\s+(\d{4}|\w+\s+\d{4}|\blast\b)/i;

/**
 * Check if the containing line has strong temporal markers indicating a past state.
 */
export function hasTemporalContext(containingLine: string): boolean {
  const lineLower = containingLine.toLowerCase();
  for (const marker of TEMPORAL_MARKERS) {
    if (lineLower.includes(marker)) return true;
  }
  if (TEMPORAL_UNTIL.test(containingLine)) return true;
  return false;
}

/**
 * Validate a fact candidate against the source content.
 * Returns validation result with reasons for rejection or flagging.
 */
export function validateFactCandidate(
  candidate: FactCandidate,
  sourceContent: string,
): ValidationResult {
  const reasons: string[] = [];
  let flagged = false;

  // Value shape checks
  const display = (candidate.display || candidate.value || "").trim();
  if (!display) {
    return { valid: false, flagged: false, reasons: ["empty_value"], containingLine: null };
  }
  if (display.length > 120) {
    return { valid: false, flagged: false, reasons: ["value_too_long"], containingLine: null };
  }

  // Predicate shape check
  const normalizedPredicate = normalizePredicate(candidate.predicate);
  const predicateCheck = isValidPredicateShape(normalizedPredicate);
  if (!predicateCheck.valid) {
    return { valid: false, flagged: false, reasons: [predicateCheck.reason!], containingLine: null };
  }

  // Excerpt grounding
  const grounding = findExcerptInSource(candidate.excerpt, sourceContent);
  if (!grounding.found) {
    return { valid: false, flagged: false, reasons: ["excerpt_not_grounded"], containingLine: null };
  }
  if (grounding.normalized) {
    flagged = true;
    reasons.push("excerpt_normalized_match");
  }

  // Extract containing line for semantic checks
  const containingLine = extractContainingLine(sourceContent, grounding.position);

  // Find excerpt position within the containing line
  const excerptPosInLine = containingLine
    .toLowerCase()
    .indexOf(candidate.excerpt.toLowerCase());
  const effectivePos = excerptPosInLine !== -1 ? excerptPosInLine : 0;

  // Speculative/question filter
  if (hasSpeculativeContext(containingLine, effectivePos)) {
    return { valid: false, flagged: false, reasons: ["speculative_language"], containingLine };
  }

  // Event-only filter
  if (hasEventOnlyContext(containingLine, candidate.excerpt)) {
    return { valid: false, flagged: false, reasons: ["event_only"], containingLine };
  }

  // Temporal flagging (flag, not reject)
  if (hasTemporalContext(containingLine)) {
    flagged = true;
    reasons.push("temporal_fact");
  }

  return { valid: true, flagged, reasons, containingLine };
}

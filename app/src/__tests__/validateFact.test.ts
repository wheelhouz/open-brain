import { describe, it, expect, vi } from "vitest";

// Mock db and openrouter to prevent import errors from facts.ts dependency chain
vi.mock("../db.js", () => ({
  query: vi.fn(),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

vi.mock("../config.js", () => ({
  config: { factConfidenceThreshold: 0.80 },
}));

import {
  validateFactCandidate,
  findExcerptInSource,
  extractContainingLine,
  hasSpeculativeContext,
  hasEventOnlyContext,
  hasTemporalContext,
} from "../validateFact.js";
import type { FactCandidate } from "../facts.js";

function makeCandidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
  return {
    entity: "Maya",
    predicate: "works_at",
    value: "Anthropic",
    display: "Anthropic",
    confidence: 0.95,
    excerpt: "works at Anthropic",
    ...overrides,
  };
}

// ─── findExcerptInSource ────────────────────────────────────────────

describe("findExcerptInSource", () => {
  it("finds exact substring", () => {
    const result = findExcerptInSource("from Porto", "Maya is from Porto");
    expect(result.found).toBe(true);
    expect(result.normalized).toBe(false);
    expect(result.position).toBe(8);
  });

  it("finds normalized match with different whitespace", () => {
    const result = findExcerptInSource("from  Porto", "Maya is from Porto");
    expect(result.found).toBe(true);
    expect(result.normalized).toBe(true);
  });

  it("finds normalized match with curly quotes", () => {
    const result = findExcerptInSource("Maya\u2019s company", "Maya's company is Anthropic");
    expect(result.found).toBe(true);
    expect(result.normalized).toBe(true);
  });

  it("returns not found for unrelated excerpt", () => {
    const result = findExcerptInSource("lives in Seattle", "Maya is from Porto");
    expect(result.found).toBe(false);
  });

  it("returns not found for empty excerpt", () => {
    const result = findExcerptInSource("", "Maya is from Porto");
    expect(result.found).toBe(false);
  });
});

// ─── extractContainingLine ──────────────────────────────────────────

describe("extractContainingLine", () => {
  it("extracts correct line from multi-line input", () => {
    const content = "First line\nMaya works at Anthropic\nThird line";
    const pos = content.indexOf("works at");
    const line = extractContainingLine(content, pos);
    expect(line).toBe("Maya works at Anthropic");
  });

  it("extracts bullet line and strips marker", () => {
    const content = "- Maya works at Anthropic\n- Call tomorrow";
    const pos = content.indexOf("works at");
    const line = extractContainingLine(content, pos);
    expect(line).toBe("Maya works at Anthropic");
  });

  it("returns char window for single-line content", () => {
    const content = "A ".repeat(200) + "Maya works at Anthropic" + " B".repeat(200);
    const pos = content.indexOf("Maya works");
    const line = extractContainingLine(content, pos);
    expect(line).toContain("Maya works at Anthropic");
  });
});

// ─── hasSpeculativeContext ───────────────────────────────────────────

describe("hasSpeculativeContext", () => {
  it("detects question mark ending", () => {
    expect(hasSpeculativeContext("Does Maya still work at Anthropic?", 0)).toBe(true);
  });

  it("detects question-word start", () => {
    expect(hasSpeculativeContext("Wondering if Maya works at Anthropic", 0)).toBe(true);
  });

  it("detects 'if' before excerpt position", () => {
    // "if" at position 18, excerpt "works at Anthropic" starts at position 38
    const line = "Need to ask Maya if she still works at Anthropic";
    const excerptPos = line.indexOf("works at Anthropic");
    expect(hasSpeculativeContext(line, excerptPos)).toBe(true);
  });

  it("does NOT flag 'still' alone (confirmatory)", () => {
    const line = "Maya still works at Anthropic";
    const excerptPos = line.indexOf("works at Anthropic");
    expect(hasSpeculativeContext(line, excerptPos)).toBe(false);
  });

  it("does NOT flag simple declarative statement", () => {
    expect(hasSpeculativeContext("Maya works at Anthropic", 0)).toBe(false);
  });

  it("detects 'maybe' in line", () => {
    expect(hasSpeculativeContext("Maya maybe works at Anthropic", 0)).toBe(true);
  });

  it("detects 'I think' in line", () => {
    expect(hasSpeculativeContext("I think Maya works at Anthropic", 0)).toBe(true);
  });

  it("detects 'might' as uncertainty", () => {
    expect(hasSpeculativeContext("Maya might move to Portland", 0)).toBe(true);
  });
});

// ─── hasEventOnlyContext ────────────────────────────────────────────

describe("hasEventOnlyContext", () => {
  it("rejects excerpt within event phrase", () => {
    expect(hasEventOnlyContext("Had coffee with Maya", "coffee with Maya")).toBe(true);
  });

  it("accepts excerpt after event phrase with clause break", () => {
    // "from Anthropic" comes after "from" clause break
    expect(hasEventOnlyContext("Had lunch with Maya from Anthropic", "from Anthropic")).toBe(false);
  });

  it("rejects when entire line is event framing", () => {
    expect(hasEventOnlyContext("Met with Maya to discuss the roadmap", "discuss the roadmap")).toBe(true);
  });

  it("accepts non-event line", () => {
    expect(hasEventOnlyContext("Maya works at Anthropic", "works at Anthropic")).toBe(false);
  });

  it("rejects excerpt overlapping event phrase", () => {
    expect(hasEventOnlyContext("Talked to Maya about her project", "Maya about her project")).toBe(true);
  });
});

// ─── hasTemporalContext ─────────────────────────────────────────────

describe("hasTemporalContext", () => {
  it("detects 'used to'", () => {
    expect(hasTemporalContext("Maya used to live in Seattle")).toBe(true);
  });

  it("detects 'formerly'", () => {
    expect(hasTemporalContext("Maya formerly worked at Google")).toBe(true);
  });

  it("detects 'previously'", () => {
    expect(hasTemporalContext("Previously worked at Meta")).toBe(true);
  });

  it("detects 'no longer'", () => {
    expect(hasTemporalContext("Maya no longer lives in Portland")).toBe(true);
  });

  it("detects 'until [year]'", () => {
    expect(hasTemporalContext("Maya worked at Google until 2022")).toBe(true);
  });

  it("does NOT flag present tense statement", () => {
    expect(hasTemporalContext("Maya works at Anthropic")).toBe(false);
  });

  it("does NOT flag bare 'was'", () => {
    expect(hasTemporalContext("Maya was at the meeting")).toBe(false);
  });
});

// ─── validateFactCandidate (integration) ────────────────────────────

describe("validateFactCandidate", () => {
  // ─── Should reject ───

  it("rejects when excerpt not found in source", () => {
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "she works at Google" }),
      "Maya works at Anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("excerpt_not_grounded");
  });

  it("rejects speculative 'Need to ask Maya if she still works at Anthropic'", () => {
    const source = "Need to ask Maya if she still works at Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "works at Anthropic" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("speculative_language");
  });

  it("rejects 'Maya might move to Portland'", () => {
    const source = "Maya might move to Portland";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "lives_in", value: "Portland", display: "Portland", excerpt: "move to Portland" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("speculative_language");
  });

  it("rejects 'Had coffee with Maya' as event-only", () => {
    const source = "Had coffee with Maya";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "met_with", value: "coffee", display: "coffee", excerpt: "coffee with Maya" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("event_only");
  });

  it("rejects 'Met with Maya to discuss the roadmap' as event-only", () => {
    const source = "Met with Maya to discuss the roadmap";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "collaborating_on", value: "roadmap", display: "roadmap", excerpt: "discuss the roadmap" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("event_only");
  });

  it("rejects predicate with too many tokens", () => {
    const source = "Maya mentioned that she prefers tea";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "mentioned_that_she_prefers", value: "tea", display: "tea", excerpt: "she prefers tea" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("predicate_too_many_tokens");
  });

  it("rejects denylist predicate", () => {
    const source = "Maya is related to the project";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "related_to", value: "project", display: "project", excerpt: "related to the project" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("predicate_denylist");
  });

  it("rejects display text longer than 120 characters", () => {
    const longValue = "A".repeat(121);
    const source = `Maya works at ${longValue}`;
    const result = validateFactCandidate(
      makeCandidate({ value: longValue, display: longValue, excerpt: longValue }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("value_too_long");
  });

  it("rejects empty value", () => {
    const result = validateFactCandidate(
      makeCandidate({ value: "", display: "", excerpt: "works at Anthropic" }),
      "Maya works at Anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("empty_value");
  });

  it("rejects 'Maya said she might be changing jobs soon'", () => {
    const source = "Maya said she might be changing jobs soon";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "changing_jobs", value: "soon", display: "soon", excerpt: "changing jobs soon" }),
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("speculative_language");
  });

  // ─── Should accept ───

  it("accepts 'Maya is from Porto and works at Anthropic' — from fact", () => {
    const source = "Maya is from Porto and works at Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "from", value: "Porto", display: "Porto", excerpt: "from Porto" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("accepts 'Maya is from Porto and works at Anthropic' — works_at fact", () => {
    const source = "Maya is from Porto and works at Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "works at Anthropic" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("accepts 'Maya created the Pulse dashboard'", () => {
    const source = "Maya created the Pulse dashboard";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "created", value: "Pulse dashboard", display: "Pulse dashboard", excerpt: "created the Pulse dashboard" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("accepts 'Had lunch with Maya from Anthropic' — non-event clause", () => {
    const source = "Had lunch with Maya from Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "from Anthropic" }),
      source,
    );
    expect(result.valid).toBe(true);
  });

  it("accepts 'Maya still works at Anthropic' — still is confirmatory", () => {
    const source = "Maya still works at Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "works at Anthropic" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("accepts 'Maya runs a newsletter at maya.substack.com'", () => {
    const source = "Maya runs a newsletter at maya.substack.com";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "newsletter_url", value: "maya.substack.com", display: "maya.substack.com", excerpt: "newsletter at maya.substack.com" }),
      source,
    );
    expect(result.valid).toBe(true);
  });

  // ─── Should flag (not reject) ───

  it("flags 'Maya used to live in Seattle' as temporal", () => {
    const source = "Maya used to live in Seattle";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "lives_in", value: "Seattle", display: "Seattle", excerpt: "used to live in Seattle" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain("temporal_fact");
  });

  it("flags 'Maya formerly worked at Google' as temporal", () => {
    const source = "Maya formerly worked at Google";
    const result = validateFactCandidate(
      makeCandidate({ predicate: "works_at", value: "Google", display: "Google", excerpt: "formerly worked at Google" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain("temporal_fact");
  });

  it("flags excerpt that only matches after normalization", () => {
    const source = "Maya works at Anthropic";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "works  at  Anthropic" }), // extra spaces
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain("excerpt_normalized_match");
  });

  // ─── Containing line from bullet list ───

  it("uses correct containing line from bullet list", () => {
    const source = "- Maya works at Anthropic\n- Call tomorrow\n- Buy groceries";
    const result = validateFactCandidate(
      makeCandidate({ excerpt: "works at Anthropic" }),
      source,
    );
    expect(result.valid).toBe(true);
    expect(result.containingLine).toBe("Maya works at Anthropic");
  });
});

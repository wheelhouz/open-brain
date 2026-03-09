# Auto-Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically detect and linkify bare URLs and domain-like text in the detail panel's markdown renderer, with special GitHub chip treatment.

**Architecture:** A pre-processing function in `web/src/lib/markdown.ts` transforms bare URLs and domain-like text into HTML before `marked` parses the content. GitHub links become inline chip elements; all others become standard `<a>` tags. CSS for GitHub chips lives in `web/src/styles/globals.css`.

**Tech Stack:** TypeScript, marked.js, Preact, Tailwind v4, Vitest

---

### Task 1: Auto-link utility — unit tests for generic domain detection

**Files:**
- Create: `web/src/lib/__tests__/autolinks.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { autoLink } from "../autolinks";

describe("autoLink", () => {
  describe("generic domains", () => {
    it("linkifies bare domain", () => {
      expect(autoLink("check out danshapiro.com for more")).toBe(
        'check out <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a> for more'
      );
    });

    it("linkifies subdomain", () => {
      expect(autoLink("visit factory.strongdm.ai today")).toBe(
        'visit <a href="https://factory.strongdm.ai" target="_blank" rel="noopener noreferrer">factory.strongdm.ai</a> today'
      );
    });

    it("linkifies domain with path", () => {
      expect(autoLink("see example.com/docs/guide")).toBe(
        'see <a href="https://example.com/docs/guide" target="_blank" rel="noopener noreferrer">example.com/docs/guide</a>'
      );
    });

    it("linkifies explicit http URLs", () => {
      expect(autoLink("go to https://example.com/foo")).toBe(
        'go to <a href="https://example.com/foo" target="_blank" rel="noopener noreferrer">https://example.com/foo</a>'
      );
    });

    it("does not linkify common abbreviations", () => {
      expect(autoLink("e.g. this or i.e. that")).toBe("e.g. this or i.e. that");
    });

    it("does not linkify inside markdown links", () => {
      expect(autoLink("[click here](https://example.com)")).toBe(
        "[click here](https://example.com)"
      );
    });

    it("does not linkify inside inline code", () => {
      expect(autoLink("run `curl example.com`")).toBe("run `curl example.com`");
    });

    it("does not linkify inside code blocks", () => {
      const input = "```\ncurl example.com\n```";
      expect(autoLink(input)).toBe(input);
    });

    it("handles domain at end of sentence with period", () => {
      expect(autoLink("Visit danshapiro.com.")).toBe(
        'Visit <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a>.'
      );
    });

    it("handles domain in parentheses", () => {
      expect(autoLink("(see danshapiro.com)")).toBe(
        '(see <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a>)'
      );
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/autolinks.test.ts`
Expected: FAIL — module `../autolinks` not found

**Step 3: Commit**

```bash
git add web/src/lib/__tests__/autolinks.test.ts
git commit -m "test: add failing tests for generic domain auto-linking"
```

---

### Task 2: Auto-link utility — implement generic domain detection

**Files:**
- Create: `web/src/lib/autolinks.ts`

**Step 1: Implement the autoLink function**

```typescript
// Common TLDs to validate domain-like patterns
const TLDS = new Set([
  "com", "org", "net", "io", "ai", "dev", "co", "me", "app", "xyz",
  "info", "biz", "us", "uk", "ca", "de", "fr", "au", "edu", "gov",
  "mil", "int", "tv", "cc", "gg", "sh", "ly", "to", "fm", "so",
  "ac", "be", "ch", "cz", "dk", "es", "fi", "hr", "hu", "id", "ie",
  "il", "in", "is", "it", "jp", "kr", "lt", "lv", "mx", "nl", "no",
  "nz", "pl", "pt", "ro", "rs", "ru", "se", "sg", "sk", "th", "tr",
  "tw", "ua", "za",
]);

// Abbreviations that look like domains but aren't
const ABBREVS = new Set(["e.g", "i.e", "etc", "vs", "vol", "dept", "govt"]);

// URL pattern: explicit http(s) or bare domain with known TLD
// Bare domain: word chars + dots, ending in known TLD, optionally followed by /path
const URL_RE =
  /https?:\/\/[^\s)\]>,;!?"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?:\/[^\s)\]>,;!?"']*)?/gi;

export function autoLink(content: string): string {
  // Protect code blocks and inline code from transformation
  const protected: { placeholder: string; original: string }[] = [];
  let idx = 0;

  // Replace code blocks with placeholders
  let safe = content.replace(/```[\s\S]*?```/g, (m) => {
    const ph = `\x00CB${idx++}\x00`;
    protected.push({ placeholder: ph, original: m });
    return ph;
  });

  // Replace inline code with placeholders
  safe = safe.replace(/`[^`]+`/g, (m) => {
    const ph = `\x00CB${idx++}\x00`;
    protected.push({ placeholder: ph, original: m });
    return ph;
  });

  // Replace markdown links with placeholders
  safe = safe.replace(/\[([^\]]+)\]\([^)]+\)/g, (m) => {
    const ph = `\x00CB${idx++}\x00`;
    protected.push({ placeholder: ph, original: m });
    return ph;
  });

  // Now auto-link URLs and bare domains
  safe = safe.replace(URL_RE, (match, tld, offset) => {
    // Check if inside a placeholder
    const before = safe.slice(Math.max(0, offset - 5), offset);
    if (before.includes("\x00")) return match;

    const isExplicit = /^https?:\/\//i.test(match);

    if (!isExplicit) {
      // Validate TLD
      if (!tld || !TLDS.has(tld.toLowerCase())) return match;

      // Check for abbreviations: look at the word before the dot
      const domainPart = match.split("/")[0];
      const withoutTld = domainPart.slice(0, -(tld.length + 1));
      if (ABBREVS.has(withoutTld.toLowerCase())) return match;
    }

    // Strip trailing punctuation that's likely sentence-ending
    let url = match;
    const trailingPunct = url.match(/[.,;:!?)]+$/);
    let suffix = "";
    if (trailingPunct) {
      // Keep trailing slash and path chars, strip sentence punctuation
      const trail = trailingPunct[0];
      // Don't strip if it looks like part of the URL (e.g., query params)
      if (!/[?&=#]/.test(url.slice(-trail.length - 1, -trail.length + 1))) {
        url = url.slice(0, -trail.length);
        suffix = trail;
      }
    }

    const href = isExplicit ? url : `https://${url}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${suffix}`;
  });

  // Restore protected content
  for (const { placeholder, original } of protected) {
    safe = safe.replace(placeholder, original);
  }

  return safe;
}
```

**Step 2: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/__tests__/autolinks.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add web/src/lib/autolinks.ts
git commit -m "feat: add autoLink utility for generic domain detection"
```

---

### Task 3: GitHub chip detection — tests

**Files:**
- Modify: `web/src/lib/__tests__/autolinks.test.ts`

**Step 1: Add GitHub-specific tests**

Add this `describe` block to the existing test file:

```typescript
describe("GitHub links", () => {
  it("renders repo as chip", () => {
    const result = autoLink("check github.com/foo/bar");
    expect(result).toContain('class="auto-link-gh"');
    expect(result).toContain("foo/bar");
    expect(result).toContain('href="https://github.com/foo/bar"');
  });

  it("renders issue as chip with #", () => {
    const result = autoLink("see github.com/foo/bar/issues/123");
    expect(result).toContain("foo/bar#123");
  });

  it("renders PR as chip with !", () => {
    const result = autoLink("see github.com/foo/bar/pull/42");
    expect(result).toContain("foo/bar!42");
  });

  it("renders commit as chip with @short-hash", () => {
    const result = autoLink("see github.com/foo/bar/commit/abc123def456");
    expect(result).toContain("foo/bar@abc123d");
  });

  it("handles explicit https github URL", () => {
    const result = autoLink("see https://github.com/foo/bar/issues/99");
    expect(result).toContain('class="auto-link-gh"');
    expect(result).toContain("foo/bar#99");
  });

  it("handles github.com with no path as generic link", () => {
    const result = autoLink("visit github.com");
    expect(result).not.toContain('class="auto-link-gh"');
    expect(result).toContain('href="https://github.com"');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/__tests__/autolinks.test.ts`
Expected: GitHub tests FAIL (no chip rendering yet)

**Step 3: Commit**

```bash
git add web/src/lib/__tests__/autolinks.test.ts
git commit -m "test: add failing tests for GitHub chip auto-linking"
```

---

### Task 4: GitHub chip detection — implementation

**Files:**
- Modify: `web/src/lib/autolinks.ts`

**Step 1: Add GitHub detection to autoLink**

Add a GitHub-specific handler before the generic link return. Inside the `URL_RE` replace callback, after computing `href` and before returning the generic `<a>` tag:

```typescript
// GitHub special handling
const ghMatch = href.match(
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/(issues|pull|commit)\/([^/?#]+))?(?:[/?#].*)?$/
);
if (ghMatch) {
  const [, owner, repo, type, num] = ghMatch;
  let label: string;
  if (type === "issues" && num) label = `${owner}/${repo}#${num}`;
  else if (type === "pull" && num) label = `${owner}/${repo}!${num}`;
  else if (type === "commit" && num) label = `${owner}/${repo}@${num.slice(0, 7)}`;
  else if (!type) label = `${owner}/${repo}`;
  else label = url; // fallback for other GitHub paths

  if (type || (!type && !num)) {
    // Only chip for owner/repo or owner/repo/type/num patterns
    const svg = `<svg class="auto-link-gh-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="auto-link-gh">${svg}<span>${label}</span></a>${suffix}`;
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/__tests__/autolinks.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add web/src/lib/autolinks.ts
git commit -m "feat: add GitHub chip rendering to autoLink"
```

---

### Task 5: Wire autoLink into the markdown renderer

**Files:**
- Modify: `web/src/lib/markdown.ts`

**Step 1: Import and call autoLink before marked**

In `web/src/lib/markdown.ts`, add at top:
```typescript
import { autoLink } from "./autolinks.js";
```

Change the `renderMarkdown` function:
```typescript
export function renderMarkdown(content: string): string {
  return marked.parse(autoLink(content)) as string;
}
```

**Step 2: Verify existing tests still pass**

Run: `cd web && npx vitest run`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add web/src/lib/markdown.ts
git commit -m "feat: wire autoLink into markdown renderer"
```

---

### Task 6: GitHub chip CSS styling

**Files:**
- Modify: `web/src/styles/globals.css`

**Step 1: Add GitHub chip styles**

Add after the `.markdown-content a` rule (line 127) in `globals.css`:

```css
/* Auto-linked GitHub chips */
.markdown-content .auto-link-gh {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.125em 0.5em;
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  text-decoration: none;
  font-size: 0.875em;
  font-weight: 500;
  line-height: 1.6;
  vertical-align: baseline;
  transition: background 0.15s;
}
.markdown-content .auto-link-gh:hover {
  background: var(--surface-hover);
  text-decoration: none;
}
.auto-link-gh-icon {
  width: 0.875em;
  height: 0.875em;
  flex-shrink: 0;
  opacity: 0.6;
}
```

**Step 2: Visual verification**

Run: `cd /home/leo/Work/src/open-brain/.worktrees/dev/auto-links && make dev`

Test with a thought containing:
- `github.com/facebook/react` → chip: [GH icon] facebook/react
- `github.com/foo/bar/issues/42` → chip: [GH icon] foo/bar#42
- `danshapiro.com` → accent-colored underlined link
- `factory.strongdm.ai/docs` → accent-colored underlined link
- `e.g. this` → no link
- `[link](https://example.com)` → normal markdown link unchanged

**Step 3: Commit**

```bash
git add web/src/styles/globals.css
git commit -m "style: add GitHub chip CSS for auto-links"
```

---

### Task 7: Final integration test

**Files:**
- Modify: `web/src/lib/__tests__/autolinks.test.ts`

**Step 1: Add edge case tests**

```typescript
describe("edge cases", () => {
  it("handles multiple links in one line", () => {
    const result = autoLink("compare github.com/a/b and github.com/c/d");
    expect(result).toContain("a/b");
    expect(result).toContain("c/d");
    expect((result.match(/auto-link-gh/g) || []).length).toBe(4); // 2 links x 2 (class + icon class)
  });

  it("handles mixed github and generic links", () => {
    const result = autoLink("see github.com/foo/bar and danshapiro.com");
    expect(result).toContain('class="auto-link-gh"');
    expect(result).toContain('href="https://danshapiro.com"');
  });

  it("does not double-link already-linked URLs in markdown", () => {
    const input = "[repo](https://github.com/foo/bar)";
    const result = autoLink(input);
    expect(result).toBe(input);
  });

  it("handles URL with query params", () => {
    const result = autoLink("see example.com/search?q=test&page=1");
    expect(result).toContain('href="https://example.com/search?q=test&page=1"');
  });
});
```

**Step 2: Run all tests**

Run: `cd web && npx vitest run src/lib/__tests__/autolinks.test.ts`
Expected: All tests PASS

**Step 3: Run full test suite**

Run: `cd /home/leo/Work/src/open-brain/.worktrees/dev/auto-links && make test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add web/src/lib/__tests__/autolinks.test.ts
git commit -m "test: add edge case tests for auto-links"
```

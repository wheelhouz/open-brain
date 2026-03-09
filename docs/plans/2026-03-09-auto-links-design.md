# Auto-Links Design

## What
Automatically detect and linkify bare URLs and domain-like text in thought content during markdown rendering in the detail panel.

## Scope
- **Where**: Detail panel only (not card previews)
- **When**: Render time in the frontend (no backend changes)

## Two link types

### 1. GitHub links (special treatment)
Bare references like `github.com/foo/bar/issues/123` become compact chips:
- Small GitHub icon + smart short label
- `github.com/foo/bar` → `foo/bar`
- `github.com/foo/bar/issues/123` → `foo/bar#123`
- `github.com/foo/bar/pull/42` → `foo/bar!42`
- `github.com/foo/bar/commit/abc123` → `foo/bar@abc123`
- Chip styled as an inline pill (background, rounded, icon + text)

### 2. Generic domain links (simple treatment)
Bare references like `danshapiro.com` or `factory.strongdm.ai/path` become standard accent-colored underlined links, same as existing markdown links. Display text is the original text as-written.

## Implementation approach
- Add a pre-processing step in `lib/markdown.ts` that runs before `marked` parses the content
- Use regex to detect domain-like patterns not already inside markdown link syntax or code blocks
- Replace matches with appropriate markdown/HTML:
  - GitHub: custom HTML chip markup
  - Generic: standard markdown link `[text](https://text)`
- Add CSS for GitHub chip styling in `globals.css`

## Detection patterns
- Explicit URLs: `https?://...` (already bare, just not linked by marked without `<>`)
- Domain-like: `word.tld`, `sub.word.tld` followed optionally by `/path` — validated against known TLDs or common patterns to avoid false positives (e.g., `e.g.` or `i.e.` should not match)

## What's excluded
- No @-mention or #hashtag linking
- No card preview linking
- No backend changes
- No link previews / unfurling

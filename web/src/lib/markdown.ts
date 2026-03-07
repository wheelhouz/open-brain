import { marked } from "marked";

// Lazy-loaded highlight.js
let hljs: typeof import("highlight.js/lib/core").default | null = null;
let hljsLoaded = false;

async function loadHljs() {
  if (hljsLoaded) return hljs;
  const [
    { default: core },
    { default: javascript },
    { default: typescript },
    { default: python },
    { default: bash },
    { default: json },
    { default: sql },
  ] = await Promise.all([
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/javascript"),
    import("highlight.js/lib/languages/typescript"),
    import("highlight.js/lib/languages/python"),
    import("highlight.js/lib/languages/bash"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/sql"),
  ]);
  core.registerLanguage("javascript", javascript);
  core.registerLanguage("js", javascript);
  core.registerLanguage("typescript", typescript);
  core.registerLanguage("ts", typescript);
  core.registerLanguage("python", python);
  core.registerLanguage("bash", bash);
  core.registerLanguage("sh", bash);
  core.registerLanguage("json", json);
  core.registerLanguage("sql", sql);
  hljs = core;
  hljsLoaded = true;
  // Dynamically import the CSS
  // @ts-ignore - CSS module import
  import("highlight.js/styles/github-dark.min.css");
  return core;
}

// Pre-load highlight.js on idle
if (typeof requestIdleCallback !== "undefined") {
  requestIdleCallback(() => loadHljs());
} else {
  setTimeout(() => loadHljs(), 100);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

const renderer = new marked.Renderer();

renderer.link = function ({ href, text }: { href: string; text: string }) {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  let highlighted: string;
  if (hljs && lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else if (hljs) {
    highlighted = hljs.highlightAuto(text).value;
  } else {
    highlighted = escapeHtml(text);
  }
  const langLabel = lang ? `<span class="text-xs text-[var(--text-muted)] absolute top-2 left-3">${escapeHtml(lang)}</span>` : "";
  return `<div class="code-block-wrapper">${langLabel}<pre><code class="hljs">${highlighted}</code></pre><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent)">Copy</button></div>`;
};

marked.use({ renderer });

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}

export function plainTextPreview(content: string, maxLines = 3): string {
  return content
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, maxLines)
    .join("\n");
}

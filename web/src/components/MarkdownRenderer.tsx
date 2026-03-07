import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../lib/markdown";

export function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      class="markdown-content text-sm text-[var(--text-primary)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

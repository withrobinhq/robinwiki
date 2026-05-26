"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import { T, FONT } from "@/lib/typography";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import type { WikiRef } from "@/lib/sidecarTypes";

const ROBIN_KNOWLEDGE_URL = "https://www.withrobin.ai/knowledge";

/**
 * Regen emits a leading title line (often "{Type}: {Name}") at the top
 * of the wiki body. On the read-only published page the page chrome
 * already renders {wiki.name} as the H1, so leaving the body-side title
 * in place makes the title appear twice. Strip the first heading- or
 * bold-paragraph-shaped line if its text contains the wiki name. Keep
 * the rule narrow (only structural title constructs, not arbitrary
 * paragraphs) so legitimate prose that happens to mention the title
 * doesn't get clipped.
 */
function stripLeadingTitle(content: string, name: string): string {
  if (!content || !name) return content;
  const needle = name.toLowerCase();

  // HTML body (Tiptap save): first <h1..h3> or first <p><strong>...
  if (content.trim().startsWith("<")) {
    const match = content.match(
      /^\s*(<(h[1-3])[^>]*>\s*([\s\S]*?)\s*<\/\2>|<p[^>]*>\s*<strong>\s*([\s\S]*?)\s*<\/strong>\s*<\/p>)\s*/i,
    );
    if (match) {
      const inner = (match[3] ?? match[4] ?? "").replace(/<[^>]*>/g, "").trim();
      if (inner.toLowerCase().includes(needle)) {
        return content.slice(match[0].length);
      }
    }
    return content;
  }

  // Markdown body: leading `#`-heading or bold-only line `**...**`
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    const stripped = raw
      .trim()
      .replace(/^#+\s+/, "")
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .trim();
    const isTitleShape = /^#+\s+/.test(raw.trim()) || /^\*\*.+\*\*$/.test(raw.trim());
    if (isTitleShape && stripped.toLowerCase().includes(needle)) {
      lines.splice(i, 1);
      while (lines[i] !== undefined && lines[i].trim() === "") {
        lines.splice(i, 1);
      }
      return lines.join("\n");
    }
    break;
  }
  return content;
}

export interface PublishedWikiData {
  name: string;
  type: string;
  publishedAt: string;
  content: string;
  refs?: Record<string, WikiRef>;
}

const bodyStyle: CSSProperties = {
  ...T.bodySmall,
  color: "var(--wiki-article-text)",
};

export function PublishedWikiArticle({ wiki }: { wiki: PublishedWikiData }) {
  const publishedDate = new Date(wiki.publishedAt).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  // Tiptap-saved bodies are HTML strings (start with `<`); markdown bodies
  // are LLM-emitted prose. ReactMarkdown escapes raw HTML, so an HTML body
  // routed through `<MarkdownContent>` renders as literal `&lt;p&gt;` text.
  // Mirror the shell page's `isHtmlBody` branch: HTML body short-circuits to
  // `dangerouslySetInnerHTML` (#253). Sanitised through `sanitizeWikiHtml`
  // (#sec-phase-1-chain-a). Trust boundary: AI-generated bodies and Tiptap
  // saves are both treated as untrusted.
  const bodyContent = stripLeadingTitle(wiki.content ?? "", wiki.name);
  const isHtmlBody =
    typeof bodyContent === "string" && bodyContent.trim().startsWith("<");

  return (
    <div className="published-page">
      <header
        className="published-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <a
          href={ROBIN_KNOWLEDGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Powered by Robin — withrobin.ai/knowledge"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "var(--heading-color)",
            textDecoration: "none",
          }}
        >
          <Image
            src="/logo.png"
            alt=""
            width={24}
            height={24}
            style={{ flexShrink: 0 }}
            aria-hidden
          />
          <span
            style={{
              ...T.bodySmall,
              fontWeight: 500,
              color: "var(--heading-color)",
            }}
          >
            Powered by Robin
          </span>
        </a>
      </header>

      <article className="published-article">
        <h1
          style={{
            ...T.h1,
            fontFamily: FONT.SERIF,
            color: "var(--heading-color)",
            margin: 0,
          }}
        >
          {wiki.name}
        </h1>
        <p
          style={{
            ...T.micro,
            color: "var(--wiki-count)",
            marginTop: 4,
            marginBottom: 24,
          }}
        >
          Published {publishedDate}
        </p>

        {isHtmlBody ? (
          <div
            className="wiki-richtext-rendered"
            style={bodyStyle}
            dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(bodyContent) }}
          />
        ) : (
          <MarkdownContent
            content={bodyContent}
            refs={wiki.refs}
            style={bodyStyle}
          />
        )}
      </article>

      <footer className="published-footer">
        <a
          href={ROBIN_KNOWLEDGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            ...T.micro,
            color: "var(--wiki-count)",
            textDecoration: "none",
          }}
        >
          Powered by Robin Wiki
        </a>
      </footer>
    </div>
  );
}

"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import { T, FONT } from "@/lib/typography";
import { WikiInfobox } from "@/components/wiki/WikiInfobox";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import type {
  WikiInfobox as WikiInfoboxData,
  WikiRef,
} from "@/lib/sidecarTypes";

const ROBIN_KNOWLEDGE_URL = "https://www.withrobin.ai/knowledge";

export interface PublishedWikiData {
  name: string;
  type: string;
  publishedAt: string;
  content: string;
  refs?: Record<string, WikiRef>;
  infobox?: WikiInfoboxData | null;
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
  const isHtmlBody =
    typeof wiki.content === "string" && wiki.content.trim().startsWith("<");

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

        {wiki.infobox && (
          <WikiInfobox
            title={wiki.name}
            image={wiki.infobox.image?.url}
            caption={wiki.infobox.caption}
            sections={[
              {
                rows: wiki.infobox.rows.map((row) => ({
                  key: row.label,
                  value: row.value,
                })),
              },
            ]}
          />
        )}

        {isHtmlBody ? (
          <div
            className="wiki-richtext-rendered"
            style={bodyStyle}
            dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(wiki.content) }}
          />
        ) : (
          <MarkdownContent
            content={wiki.content}
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

"use client";

import type { CSSProperties } from "react";
import { T, FONT } from "@/lib/typography";
import { WikiInfobox } from "@/components/wiki/WikiInfobox";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import type {
  WikiInfobox as WikiInfoboxData,
  WikiRef,
} from "@/lib/sidecarTypes";

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
          href="https://withrobin.ai/knowledge"
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
          <svg
            viewBox="0 0 27 27"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            width={22}
            height={22}
            aria-hidden
            style={{ flexShrink: 0 }}
          >
            <path
              d="M9.13646 11.1135L11.4799 13.4569L11.4869 13.45L13.121 15.084L13.1279 15.091L15.5145 17.4775C17.7112 19.6742 21.2727 19.6742 23.4694 17.4775C25.6662 15.2808 25.6662 11.7193 23.4694 9.52255C21.2727 7.32584 17.7112 7.32584 15.5145 9.52255L14.7119 10.3251L16.3029 11.9161L17.1055 11.1135C18.4234 9.79552 20.5604 9.79552 21.8784 11.1135C23.1965 12.4316 23.1965 14.5684 21.8784 15.8865C20.5604 17.2045 18.4234 17.2045 17.1055 15.8865L14.7741 13.5553L14.7671 13.5623L10.7274 9.52255C8.53075 7.32584 4.9692 7.32584 2.7725 9.52255C0.575797 11.7193 0.575797 15.2808 2.7725 17.4775C4.9692 19.6742 8.53075 19.6742 10.7274 17.4775L11.5299 16.675L9.93893 15.084L9.13646 15.8865C7.81844 17.2045 5.6815 17.2045 4.36349 15.8865C3.04547 14.5684 3.04547 12.4316 4.36349 11.1135C5.6815 9.79552 7.81844 9.79552 9.13646 11.1135Z"
              fill="currentColor"
            />
          </svg>
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
        <a
          href="https://github.com/withrobinhq/robinwiki"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Star Robin Wiki on GitHub"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--card-border)",
            color: "var(--heading-color)",
            textDecoration: "none",
            background: "var(--bg)",
          }}
        >
          <svg
            className="lucide-star"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            xmlns="http://www.w3.org/2000/svg"
            width={16}
            height={16}
            aria-hidden
            style={{ flexShrink: 0 }}
          >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          <span
            style={{
              ...T.bodySmall,
              fontWeight: 500,
              color: "var(--heading-color)",
            }}
          >
            Star on GitHub
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
        <span style={{ ...T.micro, color: "var(--wiki-count)" }}>
          Powered by Robin Wiki
        </span>
      </footer>
    </div>
  );
}

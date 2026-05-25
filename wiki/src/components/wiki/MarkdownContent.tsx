"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { CSSProperties, ReactNode } from "react";
import { T } from "@/lib/typography";
import { WikiChip } from "@/components/wiki/WikiChip";
import { fragmentCitationHref } from "@/components/wiki/WikiCitations";
import remarkWikiTokens, { WIKI_CHIP_DATA_ATTR } from "@/lib/remarkWikiTokens";
import { refToHref, type RefsMap } from "@/lib/htmlTokenSubstitute";

const baseText: CSSProperties = {
  ...T.bodySmall,
  color: "var(--wiki-article-text)",
  lineHeight: 1.6,
};

/**
 * Extract the token-key attribute from a synthetic `<span>` emitted by
 * `remarkWikiTokens`. React converts the `data-wiki-chip-key` attribute
 * we set in the plugin into a prop with the same name on the element
 * component, so we read it directly from props.
 */
function resolveChipProps(
  props: Record<string, unknown>,
): { chipKey: string; raw: ReactNode } | null {
  const key = props[WIKI_CHIP_DATA_ATTR];
  if (typeof key !== "string" || key.length === 0) return null;
  // children carries the original raw token text (e.g. "[[person:foo]]")
  // so we can fall back to it when refs has no entry (Q1 locked decision).
  const raw = (props as { children?: ReactNode }).children ?? key;
  return { chipKey: key, raw };
}

/**
 * Map from fragment ref id to its document-wide citation number.
 * Built by SectionedMarkdownBody from the section citations array
 * and threaded into MarkdownContent so inline [[fragment:slug]]
 * tokens render as numbered superscripts instead of full-title chips.
 */
export type FragmentCitationMap = Map<string, number>;

function buildComponents(
  refs: RefsMap | undefined,
  fragmentCitationMap?: FragmentCitationMap,
): Components {
  const renderSpan: NonNullable<Components["span"]> = (rawProps) => {
    // react-markdown threads a `node` extra prop when `passNode` is on;
    // strip it so it never leaks onto the DOM where React would warn.
    const { children, node: _node, ...rest } =
      rawProps as typeof rawProps & { node?: unknown };
    void _node;

    const resolved = resolveChipProps({ ...rest, children } as Record<string, unknown>);
    if (!resolved) {
      // Not a wiki-chip span — pass through untouched.
      return <span {...rest}>{children}</span>;
    }

    const ref = refs?.[resolved.chipKey];
    if (!ref) {
      // Unresolved tokens fall back gracefully when we can. Person
      // tokens like `[[person:sam-altman]]` get rendered as a plain
      // title-case name ("Sam Altman") so a hallucinated slug or a
      // missing Person row (e.g. the owner under the single-user
      // collapse) doesn't leak token syntax into the body. Other
      // kinds keep the raw-text fallback so they're debuggable.
      if (resolved.chipKey.startsWith("person:")) {
        const slug = resolved.chipKey.slice("person:".length);
        const display = slug
          .split("-")
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        return <>{display}</>;
      }
      return <>{resolved.raw}</>;
    }

    // Fragment refs render as numbered superscript citations (#351).
    if (ref.kind === "fragment") {
      const citationNum = fragmentCitationMap?.get(ref.id);
      const label = citationNum != null
        ? `[${citationNum}]`
        : `[${ref.slug?.charAt(0) ?? "?"}]`;
      const href = fragmentCitationHref(ref.id);
      return (
        <sup data-slot="wiki-citation-inline" className="cite">
          <a href={href} title={ref.label}>{label}</a>
        </sup>
      );
    }

    // Q2: single chip style — pass label + href only, no kind variant.
    return <WikiChip label={ref.label} href={refToHref(ref)} />;
  };

  return {
    span: renderSpan,
    h1: ({ children }) => (
      <h2
        style={{
          ...T.h2,
          color: "var(--wiki-article-h2)",
          margin: "24px 0 8px",
          borderBottom: "1px solid var(--wiki-card-border)",
          paddingBottom: 4,
        }}
      >
        {children}
      </h2>
    ),
    h2: ({ children }) => (
      <h2
        style={{
          ...T.h2,
          color: "var(--wiki-article-h2)",
          margin: "24px 0 8px",
          borderBottom: "1px solid var(--wiki-card-border)",
          paddingBottom: 4,
        }}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        style={{
          ...T.h3,
          color: "var(--wiki-article-h2)",
          margin: "20px 0 6px",
        }}
      >
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4
        style={{
          ...T.h4,
          color: "var(--wiki-article-h2)",
          margin: "16px 0 4px",
        }}
      >
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p style={{ ...baseText, margin: "8px 0" }}>{children}</p>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        style={{
          color: "var(--wiki-article-link)",
          textDecoration: "underline",
          textDecorationSkipInk: "none",
        }}
        target={href?.startsWith("http") ? "_blank" : undefined}
        rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul
        style={{
          ...baseText,
          listStyle: "disc",
          paddingLeft: 24,
          margin: "8px 0",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        style={{
          ...baseText,
          listStyle: "decimal",
          paddingLeft: 24,
          margin: "8px 0",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {children}
      </ol>
    ),
    li: ({ children }) => <li style={{ margin: 0 }}>{children}</li>,
    strong: ({ children }) => (
      <strong style={{ fontWeight: 600 }}>{children}</strong>
    ),
    em: ({ children }) => <em>{children}</em>,
    blockquote: ({ children }) => (
      <blockquote
        style={{
          borderLeft: "3px solid var(--wiki-card-border)",
          paddingLeft: 16,
          margin: "12px 0",
          color: "var(--wiki-article-text)",
          opacity: 0.8,
          fontStyle: "italic",
        }}
      >
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) {
        return (
          <code
            style={{
              display: "block",
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          style={{
            fontFamily: "monospace",
            fontSize: "0.9em",
            backgroundColor: "var(--wiki-card-border)",
            padding: "1px 4px",
            borderRadius: 3,
          }}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre
        style={{
          backgroundColor: "var(--code-block-bg)",
          border: "1px solid var(--wiki-card-border)",
          borderRadius: 4,
          padding: 12,
          margin: "12px 0",
          overflow: "auto",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {children}
      </pre>
    ),
    hr: () => (
      <hr
        style={{
          border: "none",
          borderTop: "1px solid var(--wiki-card-border)",
          margin: "16px 0",
        }}
      />
    ),
  };
}

interface MarkdownContentProps {
  content: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Map from `${kind}:${slug}` (or unqualified slug) to the hydrated
   * `WikiRef`. When provided, `[[kind:slug]]` tokens in `content` are
   * rendered as `<WikiChip>` pills; otherwise they fall through as
   * raw text (Q1: unresolved tokens render their literal `[[...]]`
   * form — we never silently drop them).
   */
  refs?: RefsMap;
  /**
   * When provided, [[fragment:slug]] tokens are rendered as numbered
   * superscript citations (<sup>[N]</sup>) instead of full-title chips.
   * The map keys are fragment ids, values are 1-based citation numbers.
   * Built by SectionedMarkdownBody from the per-section citation data.
   */
  fragmentCitationMap?: FragmentCitationMap;
}

export function MarkdownContent({ content, className, style, refs, fragmentCitationMap }: MarkdownContentProps) {
  const components = buildComponents(refs, fragmentCitationMap);
  return (
    <div className={className} style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiTokens]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

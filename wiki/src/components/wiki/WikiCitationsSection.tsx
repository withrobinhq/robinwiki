"use client";

/**
 * #245 — Document-wide citations section rendered at the bottom of a
 * wiki body. Each list item carries `id="fragment-{lookupKey}"` so the
 * superscript anchors emitted by `<WikiCitations>` (which target
 * `#fragment-{lookupKey}`) jump to the right row.
 *
 * Numbering is document-wide and matches the order of first appearance
 * in the body — that's the same ordering the consumer threads into
 * `<WikiCitations>` via the `startIndex` prop, so the numbers shown in
 * the body line up with the numbers shown here.
 *
 * The section accepts the flat list of citations in document-order
 * (with duplicates) and dedups internally by `fragmentId`. A fragment
 * cited from three different sections still appears once at the bottom
 * — but every superscript pointing at it lands on the same row.
 *
 * Empty input renders nothing — no empty wrapper, no trailing rule.
 */

import Link from "next/link";
import type { CSSProperties } from "react";
import type { WikiCitation } from "@/lib/sidecarTypes";
import { ROUTES } from "@/lib/routes";

/**
 * Format an ISO date for the citation row's "Captured" line. Mirrors
 * the formatter inside `WikiCitations` so the tooltip and the bottom
 * list show the same date treatment.
 */
function formatCapturedAt(capturedAt: string): string {
  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.getTime())) return capturedAt;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface WikiCitationsSectionProps {
  /**
   * Flat list of citations in document order (duplicates allowed).
   * The component dedups by `fragmentId` and renders each fragment
   * once, in order of first appearance.
   */
  citations: WikiCitation[];
  /** Optional heading override; defaults to "Citations". */
  heading?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Internal: dedup by fragmentId, preserving first-appearance order.
 */
function dedupByFragmentId(citations: WikiCitation[]): WikiCitation[] {
  const seen = new Set<string>();
  const out: WikiCitation[] = [];
  for (const c of citations) {
    if (seen.has(c.fragmentId)) continue;
    seen.add(c.fragmentId);
    out.push(c);
  }
  return out;
}

export function WikiCitationsSection({
  citations,
  heading = "Citations",
  className,
  style,
}: WikiCitationsSectionProps) {
  const deduped = dedupByFragmentId(citations);
  if (deduped.length === 0) return null;

  return (
    <section
      data-slot="wiki-citations-section"
      className={className}
      style={{
        marginTop: 32,
        paddingTop: 16,
        borderTop: "1px solid var(--wiki-card-border)",
        ...style,
      }}
    >
      {heading && (
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            margin: "0 0 12px",
            color: "var(--wiki-article-h2)",
          }}
        >
          {heading}
        </h2>
      )}
      <ol
        style={{
          listStyle: "decimal",
          paddingInlineStart: 24,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {deduped.map((c) => (
          <li
            key={c.fragmentId}
            id={`fragment-${c.fragmentId}`}
            data-slot="wiki-citation-row"
            style={{ scrollMarginTop: 80 }}
          >
            <Link
              href={ROUTES.fragment(c.fragmentId)}
              style={{
                color: "var(--wiki-article-link)",
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              {c.fragmentSlug}
            </Link>
            {c.quote ? (
              <span style={{ marginLeft: 8, fontStyle: "italic", opacity: 0.85 }}>
                &ldquo;{c.quote}&rdquo;
              </span>
            ) : null}
            <span style={{ marginLeft: 8, opacity: 0.6, fontSize: 12 }}>
              Captured {formatCapturedAt(c.capturedAt)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

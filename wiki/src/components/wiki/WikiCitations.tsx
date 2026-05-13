"use client";

/**
 * Numbered citation superscripts for the wiki body.
 *
 * Each superscript renders as a `<sup>[N]</sup>` whose anchor target is
 * the in-page citations section (`#fragment-{lookupKey}`) at the bottom
 * of the article — see `<WikiCitationsSection>`. #245 made the
 * numbering document-wide and the hrefs in-page anchors; the component
 * still accepts `startIndex` so the consumer (SectionedMarkdownBody)
 * can thread a running offset across sections without duplication.
 *
 * Hovering still shows the captured quote + date via the shared
 * `<Tooltip>`. The native `title` attribute is kept as a fallback for
 * keyboard focus and users with JS disabled.
 *
 * Styling reuses the existing `.cite` class defined in
 * `wiki/src/app/globals.css` (superscript + `--wiki-link` color). No new
 * CSS is introduced here; the component composes the visual treatment
 * in one place.
 */

import { Tooltip } from "@/components/ui/tooltip";
import type { FragmentCitationMap } from "@/components/wiki/MarkdownContent";
import type { WikiCitation } from "@/lib/sidecarTypes";

/**
 * Format an ISO date string for the tooltip "Captured" line. Falls back to
 * the raw string if `Date` parsing fails so we never swallow backend output
 * the user might still want to see.
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

/**
 * In-page anchor target for a fragment lookupKey. The matching `id`
 * lives on the citations-section list item rendered by
 * `<WikiCitationsSection>`. Kept as a tiny helper so the contract
 * stays in one place — change the prefix here and downstream consumers
 * follow.
 */
export function fragmentCitationHref(lookupKey: string): string {
  return `#fragment-${lookupKey}`;
}

interface CitationSuperscriptProps {
  citation: WikiCitation;
  index: number;
}

function CitationSuperscript({ citation, index }: CitationSuperscriptProps) {
  const href = fragmentCitationHref(citation.fragmentId);
  const tooltipContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {citation.quote && (
        <span style={{ fontStyle: "italic" }}>&ldquo;{citation.quote}&rdquo;</span>
      )}
      <span style={{ opacity: 0.7, fontSize: 11 }}>
        Captured {formatCapturedAt(citation.capturedAt)}
      </span>
    </div>
  );

  // Reuse the `.cite` superscript treatment from globals.css. The anchor
  // is a plain `<a>` (in-page hash, not a route) wrapped in `<Tooltip>`
  // so hover reveals the quote+capturedAt card.
  return (
    <Tooltip content={tooltipContent}>
      <sup data-slot="wiki-citation" className="cite">
        <a href={href} title={citation.quote ?? undefined}>
          [{index}]
        </a>
      </sup>
    </Tooltip>
  );
}

interface WikiCitationsProps {
  citations: WikiCitation[];
  /**
   * Document-wide citation numbering map. Keys are fragment ids, values
   * are 1-based citation numbers. When provided, each superscript looks
   * up its number in the map so inline `[N]` and bottom-of-section `[N]`
   * always agree. Preferred over `startIndex`.
   */
  citationMap?: FragmentCitationMap;
  /**
   * Starting index for the superscripts. Defaults to `1`. Only used as
   * a fallback when `citationMap` is not provided — if both are given,
   * `citationMap` wins.
   *
   * @deprecated Prefer `citationMap` for document-wide numbering.
   */
  startIndex?: number;
  className?: string;
}

export function WikiCitations({
  citations,
  citationMap,
  startIndex = 1,
  className,
}: WikiCitationsProps) {
  if (citations.length === 0) return null;

  return (
    <span data-slot="wiki-citations" className={className}>
      {citations.map((citation, i) => (
        <CitationSuperscript
          key={citation.fragmentId}
          citation={citation}
          index={citationMap?.get(citation.fragmentId) ?? startIndex + i}
        />
      ))}
    </span>
  );
}

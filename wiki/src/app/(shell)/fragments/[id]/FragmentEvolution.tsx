"use client";

/**
 * Stream F4: fragment evolution timeline.
 *
 * Renders the edit history of a single fragment as a vertical timeline.
 * Each entry shows a timestamp, the source client (mcp/api/web/regen),
 * and a word-level diff against the previous version's content
 * snapshot. Collapsed by default behind an "Edited N times" affordance
 * so low-edit fragments stay visually quiet; the latest edit's diff
 * stays expanded once the user opens the section.
 *
 * Fetches `GET /fragments/:id/history` via `useFragmentEditHistory`.
 * The endpoint is owned by Stream A5 and ships in parallel with this
 * component; absence (404 / 0 edits) renders the zero-state copy.
 *
 * Diff rendering reuses `wikiDiff.ts` (jsdiff word-level + whitespace
 * demotion) so the visual treatment matches the wiki revision timeline
 * a few clicks away. Reusing the engine is also why the component
 * stays well under the 250-LOC budget.
 */

import { useMemo, useState } from "react";
import { T, FONT } from "@/lib/typography";
import {
  diffStats,
  diffWords,
  type DiffPart,
} from "@/components/wiki/wikiDiff";
import {
  useFragmentEditHistory,
  type FragmentEditRecord,
} from "@/hooks/useFragmentEditHistory";

type FragmentEvolutionProps = {
  fragmentId: string;
  /**
   * Current fragment body. Used as the "after" state for the most
   * recent edit's diff — the history endpoint stores prior snapshots,
   * so the latest snapshot is whatever the page itself is rendering.
   */
  currentContent: string;
};

const formatAbsolute = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatRelative = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const seconds = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
};

/**
 * Normalise a `source` token (mcp/api/web/regen/user) into a short
 * human label. Falls back to the raw value so an unfamiliar source
 * token from a future writer still shows up rather than silently
 * disappearing.
 */
function sourceLabel(source: string): string {
  switch (source) {
    case "mcp":
      return "via MCP";
    case "api":
      return "via API";
    case "web":
      return "via Web";
    case "regen":
      return "via Regen";
    case "user":
      return "Edited";
    default:
      return source ? `via ${source}` : "Edited";
  }
}

/**
 * Author label per edit. Today the per-fragment endpoint exposes
 * `source` only; "who" is implied by the source — `regen` means
 * Robin, anything else means the human operator. A5 may add an
 * explicit `actor` field later; we read it defensively when present.
 */
function authorFor(edit: FragmentEditRecord): string {
  const e = edit as FragmentEditRecord & { actor?: string };
  if (typeof e.actor === "string" && e.actor.length > 0) return e.actor;
  return edit.source === "regen" ? "Robin" : "You";
}

const diffStyles = {
  added: {
    backgroundColor: "var(--diff-added-bg)",
    color: "var(--diff-added-text)",
    textDecoration: "none",
    padding: "0 1px",
    borderRadius: 2,
  },
  removed: {
    backgroundColor: "var(--diff-removed-bg)",
    color: "var(--diff-removed-text)",
    textDecoration: "line-through",
    padding: "0 1px",
    borderRadius: 2,
  },
  equal: {
    color: "var(--wiki-sidebar-text)",
  },
} as const;

function DiffInline({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={diffStyles[p.type]}>
          {p.value}
        </span>
      ))}
    </>
  );
}

type ComputedEntry = {
  edit: FragmentEditRecord;
  parts: DiffPart[];
  added: number;
  removed: number;
};

/**
 * Walk the edit list newest-first and diff each snapshot against the
 * snapshot that came before it (chronologically). The newest edit's
 * "after" is the live `currentContent` rendered by the page; older
 * edits diff against the next-newer entry's snapshot.
 */
function computeEntries(
  edits: FragmentEditRecord[],
  currentContent: string,
): ComputedEntry[] {
  return edits.map((edit, idx) => {
    const after = idx === 0 ? currentContent : edits[idx - 1].contentSnippet;
    const before = edit.contentSnippet;
    const parts = diffWords(before, after);
    const stats = diffStats(parts);
    return { edit, parts, added: stats.added, removed: stats.removed };
  });
}

export function FragmentEvolution({
  fragmentId,
  currentContent,
}: FragmentEvolutionProps) {
  const { data, isLoading, error } = useFragmentEditHistory(fragmentId);
  // Collapsed by default — the page is sparse and most fragments have
  // zero or one edit. The outer affordance reads "Edited N times".
  const [open, setOpen] = useState(false);
  // Per-row diff toggle. The newest entry stays expanded once the
  // outer section opens; older entries stay collapsed until clicked.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const edits = data?.edits ?? [];
  const entries = useMemo(
    () => computeEntries(edits, currentContent),
    [edits, currentContent],
  );

  if (isLoading) {
    return null;
  }
  if (error) {
    return (
      <p
        style={{
          ...T.bodySmall,
          fontFamily: FONT.SANS,
          color: "var(--wiki-count)",
          fontStyle: "italic",
          margin: "12px 0 0 0",
        }}
      >
        Edit history unavailable.
      </p>
    );
  }
  if (edits.length === 0) {
    return (
      <p
        style={{
          ...T.bodySmall,
          fontFamily: FONT.SANS,
          color: "var(--wiki-count)",
          fontStyle: "italic",
          margin: "12px 0 0 0",
        }}
      >
        No edits recorded yet.
      </p>
    );
  }

  const buttonLabel = open
    ? `Hide ${edits.length === 1 ? "edit" : "edits"}`
    : `Edited ${edits.length} ${edits.length === 1 ? "time" : "times"}`;

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          ...T.bodySmall,
          fontFamily: FONT.SANS,
          color: "var(--wiki-link)",
          textDecoration: "underline",
        }}
      >
        {buttonLabel}
      </button>

      {open && (
        <div
          className="fragment-evolution-timeline"
          style={{
            position: "relative",
            paddingLeft: 20,
            marginTop: 12,
            borderLeft: "1px solid var(--wiki-meta-line)",
          }}
        >
          {entries.map((entry, idx) => {
            const isLatest = idx === 0;
            const isOpen = expanded[entry.edit.id] ?? isLatest;
            const hasDiff = entry.parts.some((p) => p.type !== "equal");

            return (
              <div
                key={entry.edit.id}
                style={{
                  position: "relative",
                  paddingBottom: idx === entries.length - 1 ? 0 : 20,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: -26,
                    top: 4,
                    width: 11,
                    height: 11,
                    borderRadius: "50%",
                    background: isLatest
                      ? "var(--foreground)"
                      : "var(--background)",
                    border: "2px solid var(--wiki-meta-line)",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      ...T.bodySmall,
                      fontFamily: FONT.SANS,
                      fontWeight: 600,
                      color: "var(--wiki-title)",
                    }}
                  >
                    {sourceLabel(entry.edit.source)}
                  </span>
                  {hasDiff ? (
                    <span
                      style={{
                        ...T.caption,
                        fontFamily: FONT.SANS,
                        color: "var(--wiki-sidebar-text)",
                        display: "inline-flex",
                        gap: 6,
                      }}
                    >
                      <span style={{ color: "var(--diff-added-text)" }}>
                        +{entry.added}
                      </span>
                      <span style={{ color: "var(--diff-removed-text)" }}>
                        -{entry.removed}
                      </span>
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    ...T.caption,
                    fontFamily: FONT.SANS,
                    color: "var(--wiki-sidebar-text)",
                    marginTop: 2,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span>{authorFor(entry.edit)}</span>
                  <span aria-hidden>·</span>
                  <span title={formatAbsolute(entry.edit.timestamp)}>
                    {formatRelative(entry.edit.timestamp)} ·{" "}
                    {formatAbsolute(entry.edit.timestamp)}
                  </span>
                </div>

                {hasDiff ? (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [entry.edit.id]: !isOpen,
                        }))
                      }
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        ...T.caption,
                        fontFamily: FONT.SANS,
                        color: "var(--wiki-link)",
                      }}
                    >
                      {isOpen ? "Hide content diff" : "Show content diff"}
                    </button>
                    {isOpen ? (
                      <pre
                        style={{
                          ...T.bodySmall,
                          fontFamily: FONT.SANS,
                          marginTop: 6,
                          padding: "10px 12px",
                          border: "1px solid var(--wiki-card-border)",
                          borderRadius: 4,
                          background: "var(--code-block-bg)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          lineHeight: "22px",
                          color: "var(--wiki-article-text)",
                        }}
                      >
                        <DiffInline parts={entry.parts} />
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

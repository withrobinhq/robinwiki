"use client";

import { useState } from "react";
import { T, FONT } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { useWikiTimeline } from "@/hooks/useWikiTimeline";
import { useWikiEditHistory } from "@/hooks/useWikiEditHistory";
import { diffWords, diffStats, type DiffPart } from "./wikiDiff";
import type {
  AuditEventSchema,
  EditRecordSchema,
} from "@/lib/generated/types.gen";

const formatAbsolute = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatRelative = (iso: string) => {
  const seconds = Math.max(
    1,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
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

function sourceLabel(source: string): string {
  switch (source) {
    case "scheduler":
      return "Scheduled";
    case "manual":
      return "Manual";
    case "on_demand":
      return "On demand";
    case "regen":
      return "Regeneration";
    case "user":
      return "User edit";
    default:
      return source;
  }
}

function eventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "wiki.regenerated":
      return "Regenerated";
    case "wiki.created":
      return "Created";
    case "wiki.updated":
      return "Updated";
    case "wiki.published":
      return "Published";
    case "wiki.unpublished":
      return "Unpublished";
    case "fragment.created":
      return "Fragment created";
    case "fragment.filed":
      return "Fragment filed";
    case "fragment.updated":
      return "Fragment updated";
    case "fragment.accepted":
      return "Fragment accepted";
    case "fragment.rejected":
      return "Fragment rejected";
    default:
      return eventType.replace(/\./g, " ");
  }
}

function extractDetailCounts(detail: unknown): {
  newCount?: number;
  updatedCount?: number;
  removedCount?: number;
  integratedCount?: number;
} | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (typeof d.newCount === "number") counts.newCount = d.newCount;
  if (typeof d.updatedCount === "number") counts.updatedCount = d.updatedCount;
  if (typeof d.removedCount === "number") counts.removedCount = d.removedCount;
  if (typeof d.integratedCount === "number")
    counts.integratedCount = d.integratedCount;
  if (typeof d.new_count === "number") counts.newCount = d.new_count;
  if (typeof d.updated_count === "number")
    counts.updatedCount = d.updated_count;
  if (typeof d.removed_count === "number")
    counts.removedCount = d.removed_count;
  if (typeof d.integrated_count === "number")
    counts.integratedCount = d.integrated_count;

  if (Object.keys(counts).length === 0) return null;
  return counts;
}

const diffStyles = {
  added: {
    backgroundColor: "var(--diff-added-bg, rgba(34,197,94,0.15))",
    color: "var(--diff-added-text, #16a34a)",
    textDecoration: "none" as const,
    padding: "0 1px",
    borderRadius: 2,
  },
  removed: {
    backgroundColor: "var(--diff-removed-bg, rgba(239,68,68,0.15))",
    color: "var(--diff-removed-text, #dc2626)",
    textDecoration: "line-through" as const,
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

function EditDiffEntry({
  edit,
  previousEdit,
  defaultExpanded,
}: {
  edit: EditRecordSchema;
  previousEdit: EditRecordSchema | null;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!previousEdit) {
    return (
      <div
        style={{
          ...T.caption,
          fontFamily: FONT.SANS,
          color: "var(--wiki-sidebar-text)",
          marginTop: 4,
        }}
      >
        Initial version
      </div>
    );
  }

  const parts = diffWords(previousEdit.contentSnippet, edit.contentSnippet);
  const stats = diffStats(parts);
  const hasChanges = stats.added > 0 || stats.removed > 0;

  if (!hasChanges) {
    return (
      <div
        style={{
          ...T.caption,
          fontFamily: FONT.SANS,
          color: "var(--wiki-sidebar-text)",
          marginTop: 4,
        }}
      >
        No text changes in preview
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            ...T.caption,
            fontFamily: FONT.SANS,
            color: "var(--wiki-link, var(--wiki-article-link))",
          }}
        >
          {expanded ? "Hide diff" : "Show diff"}
        </button>
        <span
          style={{
            ...T.caption,
            fontFamily: FONT.SANS,
            color: "var(--wiki-sidebar-text)",
            display: "inline-flex",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--diff-added-text, #16a34a)" }}>
            +{stats.added}
          </span>
          <span style={{ color: "var(--diff-removed-text, #dc2626)" }}>
            -{stats.removed}
          </span>
        </span>
      </div>
      {expanded && (
        <pre
          style={{
            ...T.bodySmall,
            fontFamily: FONT.SANS,
            marginTop: 6,
            padding: "10px 12px",
            border: "1px solid var(--wiki-card-border)",
            borderRadius: 4,
            background: "var(--code-block-bg, var(--surface-subtle))",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: "22px",
            color: "var(--wiki-article-text)",
          }}
        >
          <DiffInline parts={parts} />
        </pre>
      )}
    </div>
  );
}

function TimelineEvent({ event }: { event: AuditEventSchema }) {
  const [expanded, setExpanded] = useState(false);
  const counts = extractDetailCounts(event.detail);

  return (
    <div style={{ position: "relative", paddingBottom: 20 }}>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: -26,
          top: 4,
          width: 11,
          height: 11,
          borderRadius: "50%",
          background: "var(--background)",
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
          {eventTypeLabel(event.eventType)}
        </span>
        <span
          style={{
            ...T.caption,
            fontFamily: FONT.SANS,
            padding: "1px 6px",
            borderRadius: 3,
            border: "1px solid var(--wiki-chip-border, var(--wiki-card-border))",
            background: "var(--wiki-chip-bg, var(--surface-subtle))",
            color: "var(--wiki-chip-text, var(--wiki-sidebar-text))",
          }}
        >
          {sourceLabel(event.source)}
        </span>
        {counts && (
          <span
            style={{
              ...T.caption,
              fontFamily: FONT.SANS,
              color: "var(--wiki-sidebar-text)",
              display: "inline-flex",
              gap: 6,
            }}
          >
            {counts.newCount != null && counts.newCount > 0 && (
              <span style={{ color: "var(--diff-added-text, #16a34a)" }}>
                +{counts.newCount} new
              </span>
            )}
            {counts.updatedCount != null && counts.updatedCount > 0 && (
              <span>{counts.updatedCount} updated</span>
            )}
            {counts.removedCount != null && counts.removedCount > 0 && (
              <span style={{ color: "var(--diff-removed-text, #dc2626)" }}>
                -{counts.removedCount} removed
              </span>
            )}
            {counts.integratedCount != null && counts.integratedCount > 0 && (
              <span>{counts.integratedCount} integrated</span>
            )}
          </span>
        )}
      </div>
      <div
        style={{
          ...T.caption,
          fontFamily: FONT.SANS,
          color: "var(--wiki-sidebar-text)",
          marginTop: 2,
        }}
      >
        <span title={formatAbsolute(event.createdAt)}>
          {formatRelative(event.createdAt)} . {formatAbsolute(event.createdAt)}
        </span>
      </div>
      {event.summary && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              ...T.caption,
              fontFamily: FONT.SANS,
              color: "var(--wiki-link, var(--wiki-article-link))",
            }}
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded && (
            <p
              style={{
                ...T.bodySmall,
                fontFamily: FONT.SANS,
                color: "var(--wiki-article-text)",
                marginTop: 4,
                padding: "8px 12px",
                border: "1px solid var(--wiki-card-border)",
                borderRadius: 4,
                background: "var(--code-block-bg, var(--surface-subtle))",
              }}
            >
              {event.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function WikiRegenTimeline({ wikiId }: { wikiId: string }) {
  const [activeTab, setActiveTab] = useState<"events" | "edits">("events");
  const timeline = useWikiTimeline(wikiId);
  const history = useWikiEditHistory(wikiId);

  const events = timeline.data?.events ?? [];
  const edits = history.data?.edits ?? [];

  const isLoading = timeline.isLoading || history.isLoading;

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 0",
        }}
      >
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 16,
          borderBottom: "1px solid var(--wiki-meta-line)",
        }}
      >
        {(["events", "edits"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            style={{
              background: "none",
              border: "none",
              borderBottom:
                activeTab === tab
                  ? "2px solid var(--foreground)"
                  : "2px solid transparent",
              cursor: "pointer",
              ...T.bodySmall,
              fontFamily: FONT.SANS,
              fontWeight: activeTab === tab ? 600 : 400,
              color:
                activeTab === tab
                  ? "var(--wiki-title)"
                  : "var(--wiki-sidebar-text)",
              paddingBottom: 8,
            }}
          >
            {tab === "events"
              ? `Audit Events (${events.length})`
              : `Edit History (${edits.length})`}
          </button>
        ))}
      </div>

      {activeTab === "events" && (
        <div
          style={{
            position: "relative",
            paddingLeft: 20,
            borderLeft: "1px solid var(--wiki-meta-line)",
            marginTop: 8,
          }}
        >
          {events.length === 0 ? (
            <div
              style={{
                ...T.bodySmall,
                fontFamily: FONT.SANS,
                color: "var(--wiki-sidebar-text)",
                padding: "12px 0",
              }}
            >
              No audit events recorded yet.
            </div>
          ) : (
            events.map((event) => (
              <TimelineEvent key={event.id} event={event} />
            ))
          )}
        </div>
      )}

      {activeTab === "edits" && (
        <div
          style={{
            position: "relative",
            paddingLeft: 20,
            borderLeft: "1px solid var(--wiki-meta-line)",
            marginTop: 8,
          }}
        >
          {edits.length === 0 ? (
            <div
              style={{
                ...T.bodySmall,
                fontFamily: FONT.SANS,
                color: "var(--wiki-sidebar-text)",
                padding: "12px 0",
              }}
            >
              No edit history recorded yet.
            </div>
          ) : (
            edits.map((edit, idx) => {
              const isLatest = idx === 0;
              const previousEdit =
                idx < edits.length - 1 ? edits[idx + 1] : null;

              return (
                <div
                  key={edit.id}
                  style={{
                    position: "relative",
                    paddingBottom: idx === edits.length - 1 ? 0 : 20,
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
                      {sourceLabel(edit.source)}
                    </span>
                    {isLatest && (
                      <span
                        style={{
                          ...T.caption,
                          fontFamily: FONT.SANS,
                          padding: "1px 6px",
                          borderRadius: 3,
                          border:
                            "1px solid var(--wiki-chip-border, var(--wiki-card-border))",
                          background:
                            "var(--wiki-chip-bg, var(--surface-subtle))",
                          color:
                            "var(--wiki-chip-text, var(--wiki-sidebar-text))",
                        }}
                      >
                        current
                      </span>
                    )}
                    <span
                      style={{
                        ...T.caption,
                        fontFamily: FONT.SANS,
                        padding: "1px 6px",
                        borderRadius: 3,
                        border:
                          "1px solid var(--wiki-chip-border, var(--wiki-card-border))",
                        background:
                          "var(--wiki-chip-bg, var(--surface-subtle))",
                        color:
                          "var(--wiki-chip-text, var(--wiki-sidebar-text))",
                      }}
                    >
                      {edit.type}
                    </span>
                  </div>
                  <div
                    style={{
                      ...T.caption,
                      fontFamily: FONT.SANS,
                      color: "var(--wiki-sidebar-text)",
                      marginTop: 2,
                    }}
                  >
                    <span title={formatAbsolute(edit.timestamp)}>
                      {formatRelative(edit.timestamp)} .{" "}
                      {formatAbsolute(edit.timestamp)}
                    </span>
                  </div>
                  <EditDiffEntry
                    edit={edit}
                    previousEdit={previousEdit}
                    defaultExpanded={isLatest}
                  />
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

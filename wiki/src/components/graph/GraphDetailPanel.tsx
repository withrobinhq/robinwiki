"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { safeRefToHref } from "@robin/shared/identity";
import { T, FONT } from "@/lib/typography";
import type { GraphData, GraphNode, GraphNodeType } from "./graphSampleData";

const TYPE_LABEL: Record<GraphNodeType, string> = {
  wiki: "Wiki",
  fragment: "Fragments",
  person: "People",
};

const TYPE_BADGE_BG: Record<GraphNodeType, string> = {
  wiki: "var(--wiki-type-log-bg)",
  fragment: "var(--fragment-type-fact-bg)",
  person: "var(--wiki-type-people-bg)",
};

const TYPE_BADGE_COLOR: Record<GraphNodeType, string> = {
  wiki: "var(--wiki-type-log-text)",
  fragment: "var(--fragment-type-fact-text)",
  person: "var(--wiki-type-people-text)",
};

const SUBTYPE_COLOR: Record<string, string> = {
  Log: "var(--wiki-type-log-text)",
  Research: "var(--wiki-type-research-text)",
  Belief: "var(--wiki-type-belief-text)",
  Decision: "var(--wiki-type-decision-text)",
  Project: "var(--wiki-type-project-text)",
  Objective: "var(--wiki-type-objective-text)",
  Skill: "var(--wiki-type-skill-text)",
  Agent: "var(--wiki-type-agent-text)",
  Voice: "var(--wiki-type-voice-text)",
  Principles: "var(--wiki-type-principles-text)",
  Fact: "var(--fragment-type-fact-text)",
  Question: "var(--fragment-type-question-text)",
  Idea: "var(--fragment-type-idea-text)",
  Action: "var(--fragment-type-action-text)",
  Quote: "var(--fragment-type-quote-text)",
  Reference: "var(--fragment-type-reference-text)",
};

const SUBTYPE_BG: Record<string, string> = {
  Log: "var(--wiki-type-log-bg)",
  Research: "var(--wiki-type-research-bg)",
  Belief: "var(--wiki-type-belief-bg)",
  Decision: "var(--wiki-type-decision-bg)",
  Project: "var(--wiki-type-project-bg)",
  Objective: "var(--wiki-type-objective-bg)",
  Skill: "var(--wiki-type-skill-bg)",
  Agent: "var(--wiki-type-agent-bg)",
  Voice: "var(--wiki-type-voice-bg)",
  Principles: "var(--wiki-type-principles-bg)",
  Fact: "var(--fragment-type-fact-bg)",
  Question: "var(--fragment-type-question-bg)",
  Idea: "var(--fragment-type-idea-bg)",
  Action: "var(--fragment-type-action-bg)",
  Quote: "var(--fragment-type-quote-bg)",
  Reference: "var(--fragment-type-reference-bg)",
};

type GraphDetailPanelProps = {
  data: GraphData;
  activeTypes: Set<GraphNodeType>;
  onToggle: (type: GraphNodeType) => void;
  selectedNode: GraphNode | null;
  onClearSelection: () => void;
  focusNodeId: string | null;
};

export function GraphDetailPanel({
  data,
  activeTypes,
  onToggle,
  selectedNode,
  onClearSelection,
}: GraphDetailPanelProps) {
  const router = useRouter();

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    right: 0,
    height: "100%",
    width: 240,
    background: "var(--graph-panel-bg)",
    borderLeft: "1px solid var(--wiki-card-border)",
    padding: 12,
    overflowY: "auto",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  };

  // Filters mode
  if (!selectedNode) {
    const counts: Record<GraphNodeType, number> = { wiki: 0, fragment: 0, person: 0 };
    data.nodes.forEach((n) => {
      counts[n.type] += 1;
    });
    const types: GraphNodeType[] = ["wiki", "fragment", "person"];

    return (
      <div style={panelStyle}>
        <div
          style={{
            ...T.bodySmall,
            fontFamily: FONT.SANS,
            fontWeight: 600,
            color: "var(--wiki-title)",
          }}
        >
          Filters
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {types.map((t) => {
            const active = activeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => onToggle(t)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 8px",
                  background: active ? "var(--wiki-search-chip-bg)" : "var(--surface-dialog-footer)",
                  border: "1px solid var(--wiki-card-border)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    ...T.bodySmall,
                    fontFamily: FONT.SANS,
                    fontWeight: 600,
                    color: active ? "var(--wiki-title)" : "var(--wiki-sidebar-text)",
                  }}
                >
                  {TYPE_LABEL[t]}
                </span>
                <span
                  style={{
                    ...T.bodySmall,
                    fontFamily: FONT.SANS,
                    color: "var(--wiki-link)",
                    opacity: active ? 1 : 0.5,
                  }}
                >
                  {counts[t]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Node detail mode
  const connectedEdges = data.edges.filter(
    (e) => e.source === selectedNode.id || e.target === selectedNode.id,
  );

  // Count connected nodes by type
  const connByType: Record<GraphNodeType, number> = { wiki: 0, fragment: 0, person: 0 };
  const nodeIdToType = new Map<string, GraphNodeType>();
  for (const n of data.nodes) {
    nodeIdToType.set(n.id, n.type);
  }
  for (const e of connectedEdges) {
    const otherId = e.source === selectedNode.id ? e.target : e.source;
    const otherType = nodeIdToType.get(otherId);
    if (otherType) connByType[otherType]++;
  }

  // Count edge types
  const edgeTypeCounts: Record<string, number> = {};
  for (const e of connectedEdges) {
    edgeTypeCounts[e.edgeType] = (edgeTypeCounts[e.edgeType] || 0) + 1;
  }

  // Build connection summary string
  const connParts: string[] = [];
  if (connByType.wiki > 0) connParts.push(`${connByType.wiki} wiki${connByType.wiki !== 1 ? "s" : ""}`);
  if (connByType.fragment > 0) connParts.push(`${connByType.fragment} fragment${connByType.fragment !== 1 ? "s" : ""}`);
  if (connByType.person > 0) connParts.push(`${connByType.person} ${connByType.person !== 1 ? "people" : "person"}`);

  // Navigation URL — guarded by safeRefToHref (#audit-M9). Treat
  // node.lookupKey as untrusted at the navigation boundary; reject
  // anything that does not match the canonical {prefix}[0-9A-Z]{26}
  // shape so a forged node can't drive router.push to an arbitrary
  // path or absolute URL.
  const handleOpen = (node: GraphNode) => {
    const ref = node.lookupKey ?? node.id;
    const href = safeRefToHref(ref);
    if (!href) {
      console.warn(
        "graph: refusing to navigate — invalid ref",
        { lookupKey: node.lookupKey, id: node.id },
      );
      return;
    }
    router.push(href);
  };

  return (
    <div style={panelStyle}>
      <button
        type="button"
        onClick={onClearSelection}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          ...T.caption,
          fontFamily: FONT.SANS,
          color: "var(--wiki-link)",
        }}
      >
        <ChevronLeft size={14} />
        Filters
      </button>

      <div
        style={{
          ...T.bodySmall,
          fontFamily: FONT.SANS,
          fontWeight: 600,
          color: "var(--wiki-title)",
        }}
      >
        {selectedNode.label}
      </div>

      {/* Type badge */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span
          style={{
            ...T.micro,
            fontFamily: FONT.SANS,
            fontWeight: 500,
            padding: "2px 8px",
            borderRadius: 10,
            background: TYPE_BADGE_BG[selectedNode.type],
            color: TYPE_BADGE_COLOR[selectedNode.type],
            textTransform: "capitalize",
          }}
        >
          {selectedNode.type}
        </span>
        {selectedNode.subtype && (
          <span
            style={{
              ...T.micro,
              fontFamily: FONT.SANS,
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: 10,
              background: SUBTYPE_BG[selectedNode.subtype] ?? "var(--surface-subtle)",
              color: SUBTYPE_COLOR[selectedNode.subtype] ?? "var(--wiki-sidebar-text)",
            }}
          >
            {selectedNode.subtype}
          </span>
        )}
      </div>

      {/* Connections section */}
      <div
        style={{
          borderTop: "1px solid var(--wiki-card-border)",
          paddingTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            ...T.caption,
            fontFamily: FONT.SANS,
            color: "var(--wiki-sidebar-text)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          Connections
        </div>
        <div
          style={{
            ...T.bodySmall,
            fontFamily: FONT.SANS,
            color: "var(--wiki-title)",
          }}
        >
          {connParts.length > 0 ? connParts.join(", ") : "No connections"}
        </div>

        {Object.keys(edgeTypeCounts).length > 0 && (
          <>
            <div
              style={{
                ...T.caption,
                fontFamily: FONT.SANS,
                color: "var(--wiki-sidebar-text)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Edge types
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {Object.entries(edgeTypeCounts).map(([type, count]) => (
                <span
                  key={type}
                  style={{
                    ...T.micro,
                    fontFamily: FONT.SANS,
                    fontWeight: 500,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "var(--surface-subtle)",
                    color: "var(--wiki-sidebar-text)",
                  }}
                >
                  {count} {type}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Open button */}
      <button
        type="button"
        onClick={() => handleOpen(selectedNode)}
        style={{
          width: "100%",
          padding: "8px 12px",
          background: "var(--wiki-title)",
          color: "var(--accent-fg)",
          border: "none",
          cursor: "pointer",
          ...T.buttonSmall,
          fontFamily: FONT.SANS,
          marginTop: "auto",
        }}
      >
        Open
      </button>
    </div>
  );
}

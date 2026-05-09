"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import GraphCanvas from "@/components/graph/GraphCanvas";
import { GraphLegend } from "@/components/graph/GraphOverlays";
import { GraphDetailPanel } from "@/components/graph/GraphDetailPanel";
import { GraphDepthSlider } from "@/components/graph/GraphDepthSlider";
import { type GraphData, type GraphNode, type GraphNodeType } from "@/components/graph/graphSampleData";
import { Spinner } from "@/components/ui/spinner";
import { useGraph } from "@/hooks/useGraph";
import { T, FONT } from "@/lib/typography";

const API_TYPE_MAP: Record<string, GraphNodeType> = {
  thread: "wiki",
  fragment: "fragment",
  person: "person",
};

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };

export default function WikiGraphPage() {
  const graphQuery = useGraph();

  const graphData = useMemo<GraphData>(() => {
    if (!graphQuery.data) return EMPTY_GRAPH;
    const api = graphQuery.data;

    const nodeIdSet = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const n of api.nodes) {
      const mappedType = API_TYPE_MAP[n.type];
      if (!mappedType) continue;
      nodeIdSet.add(n.id);
      nodes.push({
        id: n.id,
        label: n.label,
        type: mappedType,
        size: n.size,
      });
    }

    const edges = api.edges.filter(
      (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target),
    );

    return { nodes, edges };
  }, [graphQuery.data]);

  const [activeTypes, setActiveTypes] = useState<Set<GraphNodeType>>(
    () => new Set<GraphNodeType>(["wiki", "fragment", "person"]),
  );
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [currentDepth, setCurrentDepth] = useState(2);

  const handleToggle = useCallback((type: GraphNodeType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelected(null);
    setFocusNodeId(null);
  }, []);

  return (
    <div className="wiki-page wiki-page--fullbleed" style={{ gap: 12 }}>
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          border: "1px solid #f4f4f4",
          background: "#ffffff",
          overflow: "hidden",
        }}
      >
        {graphQuery.isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : graphQuery.isError ? (
          <div className="flex h-full w-full items-center justify-center flex-col gap-2">
            <p style={{ ...T.body, color: "var(--wiki-count)" }}>Failed to load graph data.</p>
            <button
              onClick={() => graphQuery.refetch()}
              style={{
                color: "var(--wiki-link)",
                textDecoration: "underline",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <GraphCanvas
            data={graphData}
            activeTypes={activeTypes}
            onSelect={setSelected}
            focusNodeId={focusNodeId}
            onFocusChange={setFocusNodeId}
            currentDepth={currentDepth}
          />
        )}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            pointerEvents: "none",
          }}
        >
          <h1
            style={{
              ...T.h1,
              fontFamily: FONT.SERIF,
              color: "var(--wiki-title)",
              margin: 0,
              fontSize: 20,
              lineHeight: "24px",
            }}
          >
            Knowledge Graph
          </h1>
          <span
            style={{
              ...T.caption,
              fontFamily: FONT.SANS,
              color: "var(--wiki-sidebar-text)",
            }}
          >
            {graphData.nodes.length} nodes · {graphData.edges.length} edges
          </span>
          {(() => {
            // Prefer the user's current selection or focus; fall back to the
            // first wiki node so the link is never dead. Restricted to wiki
            // ids since the ego route is wiki-scoped in Phase 1.
            const egoTarget =
              selected?.id ??
              focusNodeId ??
              graphData.nodes.find((n) => n.type === "wiki")?.id;
            if (!egoTarget) return null;
            return (
              <Link
                href={`/graph/ego/${egoTarget}`}
                style={{
                  ...T.caption,
                  fontFamily: FONT.SANS,
                  color: "var(--wiki-link)",
                  textDecoration: "underline",
                  pointerEvents: "auto",
                }}
              >
                Open ego view
              </Link>
            );
          })()}
        </div>
        <GraphLegend style={{ top: 48 }} />
        <GraphDetailPanel
          data={graphData}
          activeTypes={activeTypes}
          onToggle={handleToggle}
          selectedNode={selected}
          onClearSelection={handleClearSelection}
          focusNodeId={focusNodeId}
        />
        <GraphDepthSlider
          depth={currentDepth}
          onDepthChange={setCurrentDepth}
          hasFocus={focusNodeId !== null}
        />
      </div>
    </div>
  );
}

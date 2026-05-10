"use client";

import { useMemo } from "react";
import { extractEgoSubgraph } from "@robin/graph";
import {
  EgoGraphEditorial,
  type EgoEdge,
  type EgoNode,
  type EdgeKind,
  type NodeType,
} from "@/components/ego-graph-editorial";
import { useGraph } from "@/hooks/useGraph";

/**
 * Map the API node `type` discriminator to the ego graph's local
 * `NodeType`. The API also emits `entry` nodes; those have no place
 * in the editorial view and are dropped along with their edges.
 */
const NODE_TYPE_MAP: Record<string, NodeType> = {
  wiki: "wiki",
  fragment: "fragment",
  person: "person",
};

/**
 * Map the API edge `edgeType` to the local `EdgeKind`. The current
 * `/graph` endpoint already pre-maps backend relation strings to
 * these three values; if a future revision starts emitting raw
 * relation kinds, extend this table to absorb the change.
 */
const EDGE_KIND_MAP: Record<string, EdgeKind> = {
  filing: "filing",
  wikilink: "wikilink",
  mention: "mention",
};

const EGO_DEPTH = 3;

interface EgoGraphPageClientProps {
  id: string;
}

export function EgoGraphPageClient({ id }: EgoGraphPageClientProps) {
  const graphQuery = useGraph();

  const view = useMemo(() => {
    if (!graphQuery.data) return null;
    const api = graphQuery.data;

    // First pass: keep only nodes whose type maps. Indexed by id so the
    // edge pass can drop anything pointing at a dropped node.
    const apiNodeById = new Map<string, (typeof api.nodes)[number]>();
    for (const n of api.nodes) {
      if (!NODE_TYPE_MAP[n.type]) continue;
      apiNodeById.set(n.id, n);
    }

    // Edges go through the kind map and lose any whose endpoints were
    // dropped above. We synthesize a stable id since the API doesn't
    // emit one.
    const egoEdges: EgoEdge[] = [];
    for (let i = 0; i < api.edges.length; i++) {
      const e = api.edges[i];
      const kind = EDGE_KIND_MAP[e.edgeType];
      if (!kind) continue;
      if (!apiNodeById.has(e.source) || !apiNodeById.has(e.target)) continue;
      egoEdges.push({
        id: `${e.source}->${e.target}#${i}`,
        source: e.source,
        target: e.target,
        kind,
      });
    }

    // Run BFS over the surviving edges to find the focus's neighborhood.
    const { visibleNodeIds, nodeHopLevels } = extractEgoSubgraph(
      egoEdges,
      id,
      EGO_DEPTH,
    );

    // Materialize the ego nodes in the shape EgoGraphEditorial expects.
    // Wiki nodes carry a subtype that maps directly to SUBTYPE_COLOR;
    // fragments and people have no subtype yet and fall back to neutral.
    const egoNodes: EgoNode[] = [];
    for (const nodeId of visibleNodeIds) {
      const apiNode = apiNodeById.get(nodeId);
      if (!apiNode) continue;
      egoNodes.push({
        id: apiNode.id,
        type: NODE_TYPE_MAP[apiNode.type]!,
        label: apiNode.label,
        size: apiNode.size,
        subtype: apiNode.subtype ?? undefined,
      });
    }

    // Drop edges whose endpoints fell outside the visible neighborhood
    // (e.g. a depth-3 neighbor's link to a depth-4 stranger).
    const filteredEgoEdges = egoEdges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    );

    const focusNode = egoNodes.find((n) => n.id === id);

    return {
      nodes: egoNodes,
      edges: filteredEgoEdges,
      hopOf: nodeHopLevels,
      focusNode,
      focusMissing: !focusNode,
    };
  }, [graphQuery.data, id]);

  if (graphQuery.isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: "100vh",
          fontFamily:
            '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif',
          color: "#3a3f48",
          fontSize: 14,
        }}
      >
        Loading graph...
      </div>
    );
  }

  if (graphQuery.isError) {
    const message =
      graphQuery.error instanceof Error
        ? graphQuery.error.message
        : "Failed to load graph data.";
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: "100vh",
          background: "#f0eee9",
          fontFamily:
            '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <div
          style={{
            background: "#fafaf6",
            border: "1px solid #cdc9bc",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            maxWidth: 360,
          }}
        >
          <div
            style={{
              fontFamily: '"STIX Two Text", "Iowan Old Style", Georgia, serif',
              fontSize: 18,
              color: "#1a1d22",
            }}
          >
            Could not load graph
          </div>
          <div style={{ fontSize: 13, color: "#3a3f48" }}>{message}</div>
          <button
            type="button"
            onClick={() => graphQuery.refetch()}
            style={{
              alignSelf: "flex-start",
              background: "#3366cc",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!view) {
    // Query resolved but produced no data (e.g. cleared cache). Treat
    // as the same loading-ish state rather than a hard error.
    return null;
  }

  if (view.focusMissing) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: "100vh",
          background: "#f0eee9",
          fontFamily:
            '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif',
          color: "#3a3f48",
          fontSize: 14,
          padding: 24,
          textAlign: "center",
        }}
      >
        This wiki has no connections yet.
      </div>
    );
  }

  return (
    <EgoGraphEditorial
      focusId={id}
      focusLabel={view.focusNode!.label}
      focusSubtype={view.focusNode!.subtype}
      nodes={view.nodes}
      edges={view.edges}
      hopOf={view.hopOf}
    />
  );
}

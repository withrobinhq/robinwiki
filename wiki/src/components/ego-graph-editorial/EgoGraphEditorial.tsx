"use client";

import { useEffect, useMemo, useState } from "react";
import type { EgoEdge, EgoNode, LaidOutNode } from "./types";
import { useEgoGraphState } from "./hooks/useEgoGraphState";
import { layoutConcentric } from "./lib/layout";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { DetailPanel } from "./components/DetailPanel";
import { Tooltip } from "./components/Tooltip";
import styles from "./EgoGraphEditorial.module.css";

export interface EgoGraphEditorialProps {
  focusId: string;
  focusLabel: string;
  focusSubtype?: string;
  /** Includes the focus node. */
  nodes: EgoNode[];
  edges: EgoEdge[];
  /** Hop distance from focus. The focus node maps to 0. */
  hopOf: Map<string, number>;
}

/**
 * Root component for the editorial ego graph view. Owns shared
 * reducer state and threads filtered nodes/edges into the three
 * visual panes plus the floating tooltip.
 */
export function EgoGraphEditorial({
  focusId,
  focusLabel,
  focusSubtype,
  nodes,
  edges,
  hopOf,
}: EgoGraphEditorialProps) {
  const { state, dispatch } = useEgoGraphState(focusId);

  const laidOut = useMemo(
    () => layoutConcentric(focusId, nodes, hopOf),
    [focusId, nodes, hopOf],
  );

  // Apply depth + type filters. The focus node always survives so the
  // graph always has its anchor, even if the user toggles its type off.
  const filtered = useMemo(() => {
    return laidOut.filter((n) => {
      if (n.id === focusId) return true;
      if (n.hop > state.depth) return false;
      if (!state.activeTypes.has(n.type)) return false;
      return true;
    });
  }, [laidOut, focusId, state.depth, state.activeTypes]);

  const filteredIds = useMemo(
    () => new Set(filtered.map((n) => n.id)),
    [filtered],
  );

  const filteredEdges = useMemo(
    () =>
      edges.filter(
        (e) => filteredIds.has(e.source) && filteredIds.has(e.target),
      ),
    [edges, filteredIds],
  );

  const nodeMap = useMemo(() => {
    const m = new Map<string, LaidOutNode>();
    for (const n of filtered) m.set(n.id, n);
    return m;
  }, [filtered]);

  // Total degree from the unfiltered edge list. Used by the tooltip so
  // the count reflects the true neighborhood size, not whatever depth
  // the user happens to be viewing.
  const totalDegree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of edges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [edges]);

  // Adjacency over the filtered edge set, used by the detail panel's
  // "direct connections" list and stat cards.
  const adjacency = useMemo(() => {
    const m = new Map<string, LaidOutNode[]>();
    for (const e of filteredEdges) {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      if (!a || !b) continue;
      if (!m.has(a.id)) m.set(a.id, []);
      if (!m.has(b.id)) m.set(b.id, []);
      m.get(a.id)!.push(b);
      m.get(b.id)!.push(a);
    }
    return m;
  }, [filteredEdges, nodeMap]);

  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  // Track mouse coords only while a node is hovered. Cheaper than a
  // permanent global listener and avoids re-rendering when nothing is
  // visible.
  useEffect(() => {
    if (!state.hover) return;
    function onMove(e: MouseEvent) {
      setTooltipPos({ x: e.clientX, y: e.clientY });
    }
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [state.hover]);

  // Esc clears selection back to the focus node. Stage already handles
  // background-click clearing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dispatch({ type: "CLEAR_SELECT" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const focusNode = nodeMap.get(focusId);

  if (!focusNode) {
    return (
      <div className={styles.app}>
        <div style={{ padding: 32, fontFamily: "var(--mono)", fontSize: 12 }}>
          {`Focus node "${focusId}" missing from graph payload.`}
        </div>
      </div>
    );
  }

  const selectedNode = state.selected
    ? (nodeMap.get(state.selected) ?? focusNode)
    : focusNode;

  const hoverNode = state.hover ? (nodeMap.get(state.hover) ?? null) : null;

  const detailNode = selectedNode;
  const detailConnections = adjacency.get(selectedNode.id) ?? [];
  const tooltipConnectionCount = hoverNode
    ? (totalDegree.get(hoverNode.id) ?? 0)
    : 0;

  return (
    <div className={styles.app}>
      <TopBar focusTitle={focusLabel} focusSubtype={focusSubtype} />
      <Sidebar
        state={state}
        dispatch={dispatch}
        nodes={laidOut}
        edges={edges}
        focusNode={focusNode}
      />
      <Stage
        nodes={filtered}
        edges={filteredEdges}
        state={state}
        dispatch={dispatch}
        focusId={focusId}
      />
      <DetailPanel
        node={detailNode}
        focusId={focusId}
        connections={detailConnections}
        onClose={() => dispatch({ type: "CLEAR_SELECT" })}
        onNavigate={(id) => dispatch({ type: "SELECT", id })}
      />
      <Tooltip
        node={hoverNode}
        screenX={tooltipPos.x}
        screenY={tooltipPos.y}
        connectionCount={tooltipConnectionCount}
      />
    </div>
  );
}

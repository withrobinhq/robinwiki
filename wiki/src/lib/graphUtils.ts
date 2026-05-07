import type { GraphEdge } from "../components/graph/graphSampleData";

// Wave G — re-export the @robin/graph adapter for callers that need to
// rejoin srcType/dstType onto edges coming back from /graph (the API
// strips them in the EDGE_TYPE_MAP projection). The in-tree
// buildAdjacencyMap / extractEgoSubgraph / shouldShowLabel below have
// extra zoom-fade smoothing the package version intentionally omits;
// keep both available rather than collapse onto one implementation.
export { enrichEdges } from "@robin/graph";
export type { EnrichedEdge, NodeWithType } from "@robin/graph";

/**
 * Build a bidirectional adjacency map from edges for O(1) neighbor lookups.
 */
export function buildAdjacencyMap(edges: GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    let srcList = map.get(e.source);
    if (!srcList) {
      srcList = [];
      map.set(e.source, srcList);
    }
    srcList.push(e.target);

    let tgtList = map.get(e.target);
    if (!tgtList) {
      tgtList = [];
      map.set(e.target, tgtList);
    }
    tgtList.push(e.source);
  }
  return map;
}

/**
 * BFS from focusId up to maxDepth hops. Returns visible node IDs and each
 * node's hop level from the focus.
 */
export function extractEgoSubgraph(
  edges: GraphEdge[],
  focusId: string,
  maxDepth: number,
  adjacencyMap?: Map<string, string[]>,
): { visibleNodeIds: Set<string>; nodeHopLevels: Map<string, number> } {
  const adj = adjacencyMap ?? buildAdjacencyMap(edges);
  const visibleNodeIds = new Set<string>();
  const nodeHopLevels = new Map<string, number>();

  // BFS
  const queue: Array<{ id: string; depth: number }> = [{ id: focusId, depth: 0 }];
  visibleNodeIds.add(focusId);
  nodeHopLevels.set(focusId, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const neighbors = adj.get(id) ?? [];
    for (const nid of neighbors) {
      if (!visibleNodeIds.has(nid)) {
        visibleNodeIds.add(nid);
        nodeHopLevels.set(nid, depth + 1);
        queue.push({ id: nid, depth: depth + 1 });
      }
    }
  }

  return { visibleNodeIds, nodeHopLevels };
}

/**
 * Progressive label visibility. Returns 0-1 alpha for a node's label based
 * on zoom level and the node's rank (sorted by size descending, 0 = largest).
 *
 * When focusNodeId is null (full-graph mode), returns 1 for all.
 * Fragment labels are handled separately (hover-only) so this should not be
 * called for fragments.
 */
export function shouldShowLabel(
  nodeId: string,
  focusNodeId: string | null,
  rank: number,
  zoom: number,
): number {
  // Full-graph mode: all labels visible
  if (focusNodeId === null) return 1;

  // Ego-center always visible
  if (nodeId === focusNodeId) return 1;

  const fadeRange = 2;
  let maxRank: number;

  if (zoom < 0.5) {
    // Only focus node
    return 0;
  } else if (zoom < 0.8) {
    maxRank = 3;
    // Smooth fade in the 0.5-0.8 zone
    const zoomFade = Math.min(1, (zoom - 0.5) / 0.1);
    if (rank < maxRank) return zoomFade;
    if (rank < maxRank + fadeRange) {
      return zoomFade * (1 - (rank - maxRank) / fadeRange);
    }
    return 0;
  } else if (zoom < 1.2) {
    maxRank = 8;
  } else {
    // > 1.2: all labels
    return 1;
  }

  if (rank < maxRank) return 1;
  if (rank < maxRank + fadeRange) {
    return 1 - (rank - maxRank) / fadeRange;
  }
  return 0;
}

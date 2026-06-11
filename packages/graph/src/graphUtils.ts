// Pure graph utilities lifted from the os.withrobin.org canvas
// (src/lib/graphUtils.ts). Adapted to a generic edge shape so the
// package can serve any caller whose edges expose `source` and
// `target` strings — Robin's GET /graph endpoint does, and the
// adapter in `enrichEdges` extends the same shape with type metadata.

/**
 * Minimal edge shape the graph utilities operate on. Callers may carry
 * additional fields (edgeType, srcType, dstType, attrs) — the utilities
 * ignore them.
 */
export interface GraphEdgeLike {
  source: string
  target: string
}

/**
 * Build a bidirectional adjacency map from edges for O(1) neighbor
 * lookups. Self-loops are tolerated; duplicate edges produce duplicate
 * neighbor entries (callers typically don't care).
 */
export function buildAdjacencyMap<E extends GraphEdgeLike>(
  edges: readonly E[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    if (!adj.has(edge.target)) adj.set(edge.target, [])
    adj.get(edge.source)?.push(edge.target)
    adj.get(edge.target)?.push(edge.source)
  }
  return adj
}

/**
 * Extract an ego subgraph via BFS from a focus node up to maxDepth
 * hops. Returns the set of visible node IDs and a map of each node's
 * hop level. Pass a precomputed adjacency map to avoid rebuilding it
 * on every depth change.
 */
export function extractEgoSubgraph<E extends GraphEdgeLike>(
  edges: readonly E[],
  focusId: string,
  maxDepth: number,
  adjacencyMap?: Map<string, string[]>
): { visibleNodeIds: Set<string>; nodeHopLevels: Map<string, number> } {
  const adj = adjacencyMap ?? buildAdjacencyMap(edges)
  const hopLevels = new Map<string, number>()
  hopLevels.set(focusId, 0)
  const queue = [focusId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const currentHop = hopLevels.get(current) ?? 0
    if (currentHop >= maxDepth) continue
    for (const neighbor of adj.get(current) ?? []) {
      if (!hopLevels.has(neighbor)) {
        hopLevels.set(neighbor, currentHop + 1)
        queue.push(neighbor)
      }
    }
  }

  return {
    visibleNodeIds: new Set(hopLevels.keys()),
    nodeHopLevels: hopLevels,
  }
}

/**
 * Determine label visibility (0 to 1) for a node based on ego focus,
 * rank, and zoom level.
 *
 * Zoom thresholds:
 *   < 0.5        only the ego-center label is visible
 *   0.5 to 0.8   top 3 by rank
 *   0.8 to 1.2   top 8 by rank
 *   > 1.2        all labels visible
 *
 * Returns a number 0 to 1 where values strictly between indicate a
 * fade zone — callers can multiply this into the canvas globalAlpha
 * to drive smooth label appearance.
 */
export function shouldShowLabel(
  nodeId: string,
  focusNodeId: string | null,
  rank: number,
  zoom: number
): number {
  if (nodeId === focusNodeId) return 1
  if (!focusNodeId) return 1 // no ego focus, show all labels
  const threshold = zoom < 0.5 ? 0 : zoom < 0.8 ? 3 : zoom < 1.2 ? 8 : Number.POSITIVE_INFINITY
  if (threshold === 0) return 0
  if (threshold === Number.POSITIVE_INFINITY) return 1
  if (rank >= threshold) return 0
  const fadeRange = 2
  if (rank > threshold - fadeRange) {
    return (threshold - rank) / fadeRange
  }
  return 1
}

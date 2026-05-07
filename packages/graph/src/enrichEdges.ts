// Adapter from Robin's edges-table row shape (srcType, srcId, dstType,
// dstId, edgeType, attrs) to the renderer-friendly shape (source,
// target, edgeType) plus enrichment fields (srcType, dstType) the
// graph renderer wants for type-aware coloring and click routing.
//
// The /graph endpoint in core already projects to source/target, but
// drops srcType/dstType. This adapter takes the server payload plus
// the matching node list (which carries the type) and rejoins the
// type metadata onto each edge.

export interface NodeWithType {
  id: string
  type: string
}

export interface EnrichedEdge<E> {
  source: string
  target: string
  srcType: string | null
  dstType: string | null
  /** Original edge object preserved as-is so callers can read edgeType,
   * attrs, or any other fields without re-fetching. */
  raw: E
}

/**
 * Build a `{ id -> type }` lookup once and reuse it for every edge.
 * Returns a frozen map so callers can safely share the result across
 * memoised renders.
 */
function buildNodeTypeMap(nodes: readonly NodeWithType[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const n of nodes) map.set(n.id, n.type)
  return map
}

/**
 * Annotate each edge with srcType/dstType resolved from the node list.
 * Edges referencing unknown nodes get `null` for the missing side; the
 * caller decides whether to drop them. Pure function — no mutation of
 * the input arrays.
 */
export function enrichEdges<E extends { source: string; target: string }>(
  edges: readonly E[],
  nodes: readonly NodeWithType[]
): EnrichedEdge<E>[] {
  const nodeTypes = buildNodeTypeMap(nodes)
  return edges.map((e) => ({
    source: e.source,
    target: e.target,
    srcType: nodeTypes.get(e.source) ?? null,
    dstType: nodeTypes.get(e.target) ?? null,
    raw: e,
  }))
}

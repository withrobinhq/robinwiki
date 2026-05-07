// @robin/graph — graph utilities and edge adapters used by Robin's
// graph view. Lifts the pure utilities from os.withrobin.org's canvas
// package and adds an adapter that bridges Robin's GET /graph payload
// to the type-enriched shape the renderer wants. See README for the
// rationale on why the React renderer itself was not lifted.

export {
  buildAdjacencyMap,
  extractEgoSubgraph,
  shouldShowLabel,
  type GraphEdgeLike,
} from './graphUtils.js'

export { enrichEdges, type EnrichedEdge, type NodeWithType } from './enrichEdges.js'

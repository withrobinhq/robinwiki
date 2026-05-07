import { describe, it, expect } from 'vitest'
import {
  buildAdjacencyMap,
  extractEgoSubgraph,
  shouldShowLabel,
} from './graphUtils.js'
import { enrichEdges } from './enrichEdges.js'

describe('buildAdjacencyMap', () => {
  it('builds a bidirectional adjacency map', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    const adj = buildAdjacencyMap(edges)
    expect(adj.get('a')).toEqual(['b'])
    expect(adj.get('b')).toEqual(['a', 'c'])
    expect(adj.get('c')).toEqual(['b'])
  })

  it('tolerates self-loops', () => {
    const adj = buildAdjacencyMap([{ source: 'x', target: 'x' }])
    expect(adj.get('x')).toEqual(['x', 'x'])
  })
})

describe('extractEgoSubgraph', () => {
  // a - b - c - d, and b - e
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
    { source: 'b', target: 'e' },
  ]

  it('returns just the focus at depth 0', () => {
    const r = extractEgoSubgraph(edges, 'b', 0)
    expect(r.visibleNodeIds).toEqual(new Set(['b']))
    expect(r.nodeHopLevels.get('b')).toBe(0)
  })

  it('includes 1-hop neighbors at depth 1', () => {
    const r = extractEgoSubgraph(edges, 'b', 1)
    expect(r.visibleNodeIds).toEqual(new Set(['a', 'b', 'c', 'e']))
    expect(r.nodeHopLevels.get('a')).toBe(1)
    expect(r.nodeHopLevels.get('e')).toBe(1)
  })

  it('expands further at depth 2', () => {
    const r = extractEgoSubgraph(edges, 'a', 2)
    expect(r.visibleNodeIds).toEqual(new Set(['a', 'b', 'c', 'e']))
    expect(r.nodeHopLevels.get('c')).toBe(2)
    expect(r.nodeHopLevels.get('e')).toBe(2)
  })

  it('reuses a precomputed adjacency map when provided', () => {
    const adj = buildAdjacencyMap(edges)
    const r = extractEgoSubgraph(edges, 'd', 1, adj)
    expect(r.visibleNodeIds).toEqual(new Set(['c', 'd']))
  })
})

describe('shouldShowLabel', () => {
  it('always shows the focus node label', () => {
    expect(shouldShowLabel('focus', 'focus', 0, 0.1)).toBe(1)
  })

  it('shows all labels when no focus is set', () => {
    expect(shouldShowLabel('any', null, 50, 0.5)).toBe(1)
  })

  it('hides everything but focus at very low zoom', () => {
    expect(shouldShowLabel('other', 'focus', 0, 0.4)).toBe(0)
  })

  it('shows top 3 ranked labels at mid zoom', () => {
    expect(shouldShowLabel('n', 'focus', 0, 0.7)).toBe(1)
    expect(shouldShowLabel('n', 'focus', 5, 0.7)).toBe(0)
  })

  it('shows top 8 ranked labels at high zoom', () => {
    expect(shouldShowLabel('n', 'focus', 5, 1.0)).toBe(1)
    expect(shouldShowLabel('n', 'focus', 20, 1.0)).toBe(0)
  })

  it('shows all labels at very high zoom', () => {
    expect(shouldShowLabel('n', 'focus', 999, 2.0)).toBe(1)
  })

  it('returns a fade value in the boundary band', () => {
    // threshold=8 at zoom 1.0, fadeRange=2, so rank=7 sits inside the
    // fade zone and should produce a value between 0 and 1.
    const fade = shouldShowLabel('n', 'focus', 7, 1.0)
    expect(fade).toBeGreaterThan(0)
    expect(fade).toBeLessThan(1)
  })
})

describe('enrichEdges', () => {
  it('annotates source/target type from the node list', () => {
    const nodes = [
      { id: 'w1', type: 'wiki' },
      { id: 'p1', type: 'person' },
    ]
    const edges = [{ source: 'w1', target: 'p1', edgeType: 'mention' }]
    const out = enrichEdges(edges, nodes)
    expect(out[0].srcType).toBe('wiki')
    expect(out[0].dstType).toBe('person')
    expect(out[0].raw).toEqual(edges[0])
  })

  it('returns null type when a referenced node is unknown', () => {
    const out = enrichEdges([{ source: 'x', target: 'y' }], [{ id: 'x', type: 'wiki' }])
    expect(out[0].srcType).toBe('wiki')
    expect(out[0].dstType).toBeNull()
  })
})

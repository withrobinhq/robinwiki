import { describe, it, expect } from 'vitest'
import { prepareContentForPublish } from './published-content.js'
import type { WikiRef } from '@robin/shared/schemas/sidecar'

type WikiRow = { slug: string; publishedSlug: string | null }

function makeFakeDb(rows: WikiRow[]) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve(rows),
  }
  return chain as unknown as Parameters<typeof prepareContentForPublish>[0]
}

const refs: Record<string, WikiRef> = {
  'wiki:ai-infrastructure': {
    kind: 'wiki',
    id: 'wiki01XYZ',
    slug: 'ai-infrastructure',
    label: 'AI Infrastructure',
    wikiType: 'log',
  },
  'wiki:vector-db': {
    kind: 'wiki',
    id: 'wiki01ABC',
    slug: 'vector-db',
    label: 'Vector DB',
    wikiType: 'log',
  },
  'person:jane-doe': {
    kind: 'person',
    id: 'person01ABC',
    slug: 'jane-doe',
    label: 'Jane Doe',
  },
  'fragment:vector-db-note': {
    kind: 'fragment',
    id: 'frag01DEF',
    slug: 'vector-db-note',
    label: 'Vector DB Note',
  },
}

describe('prepareContentForPublish', () => {
  it('emits a markdown link when the wiki target is itself published', async () => {
    const db = makeFakeDb([{ slug: 'ai-infrastructure', publishedSlug: 'abc123' }])
    const input = 'See [[wiki:ai-infrastructure]] for more.'
    const result = await prepareContentForPublish(db, input, refs)
    expect(result).toBe('See [AI Infrastructure](/p/abc123) for more.')
  })

  it('drops the link for a wiki target that is private (not published)', async () => {
    const db = makeFakeDb([])
    const input = 'See [[wiki:ai-infrastructure]] for more.'
    const result = await prepareContentForPublish(db, input, refs)
    expect(result).toBe('See AI Infrastructure for more.')
  })

  it('escapes square brackets in the link label so user names can not break markdown', async () => {
    const db = makeFakeDb([{ slug: 'ai-infrastructure', publishedSlug: 'abc123' }])
    const labelWithBrackets: Record<string, WikiRef> = {
      'wiki:ai-infrastructure': {
        kind: 'wiki',
        id: 'wiki01XYZ',
        slug: 'ai-infrastructure',
        label: 'Q4 [2026] Plan',
        wikiType: 'log',
      },
    }
    const result = await prepareContentForPublish(db, 'See [[wiki:ai-infrastructure]].', labelWithBrackets)
    expect(result).toBe('See [Q4 \\[2026\\] Plan](/p/abc123).')
  })

  it('drops person tokens to plain text', async () => {
    const db = makeFakeDb([])
    const input = '[[person:jane-doe]] noted this.'
    const result = await prepareContentForPublish(db, input, refs)
    expect(result).toBe('Jane Doe noted this.')
  })

  it('removes fragment tokens entirely along with leading whitespace', async () => {
    const db = makeFakeDb([])
    const input = 'A great point [[fragment:vector-db-note]] and another idea.'
    const result = await prepareContentForPublish(db, input, refs)
    expect(result).toBe('A great point and another idea.')
  })

  it('strips inline citation markers', async () => {
    const db = makeFakeDb([])
    const input = 'This is a fact[1] with multiple citations[2][12].'
    const result = await prepareContentForPublish(db, input, refs)
    expect(result).toBe('This is a fact with multiple citations.')
  })

  it('returns empty content unchanged', async () => {
    const db = makeFakeDb([])
    expect(await prepareContentForPublish(db, '', refs)).toBe('')
  })
})

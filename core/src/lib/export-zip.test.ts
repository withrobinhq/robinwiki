import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Readable } from 'node:stream'
import yauzl from 'yauzl'

// Stubbed rows mimicking the drizzle row shape buildExportZip selects.
// Embeddings + searchVector are present so we can confirm they get stripped
// from the JSON payloads.
const stubWikis = [
  {
    lookupKey: 'wiki_aaa',
    slug: 'wiki-one',
    name: 'Wiki One',
    type: 'log',
    description: 'first wiki',
    state: 'RESOLVED',
    content: '# Wiki One\n\nBody text.',
    published: false,
    publishedSlug: null,
    publishedAt: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-02T00:00:00Z'),
    lastRebuiltAt: null,
    embedding: 'should-be-stripped',
    searchVector: 'should-be-stripped',
    deletedAt: null,
  },
]

const stubEntries = [
  {
    lookupKey: 'entry_xyz',
    slug: 'entry-one',
    title: '',
    type: 'thought',
    source: 'api',
    ingestStatus: 'pending',
    state: 'PENDING',
    content: 'raw user thought',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-02T00:00:00Z'),
    deletedAt: null,
  },
]

const stubFragments = [
  {
    lookupKey: 'frag_111',
    slug: 'frag-one',
    title: 'Fragment one',
    content: 'fragment text',
    embedding: 'should-be-stripped',
    searchVector: 'should-be-stripped',
    deletedAt: null,
  },
]

const stubPeople = [
  {
    lookupKey: 'person_p1',
    slug: 'alice',
    name: 'Alice',
    embedding: 'should-be-stripped',
    deletedAt: null,
  },
]

const stubEdges = [
  {
    id: 'edge_1',
    srcType: 'fragment',
    srcId: 'frag_111',
    dstType: 'wiki',
    dstId: 'wiki_aaa',
    edgeType: 'FRAGMENT_IN_WIKI',
    attrs: null,
    deletedAt: null,
    createdAt: new Date('2026-05-02T00:00:00Z'),
  },
]

vi.mock('../db/client.js', () => {
  // Each select() call routes to a different table. The route order in
  // buildExportZip is: wikis, entries, fragments, people, edges. We
  // return a chainable thenable per call by tracking call index.
  let call = 0
  const tables = [stubWikis, stubEntries, stubFragments, stubPeople, stubEdges]
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(tables[call++ % tables.length]),
        }),
      }),
    },
  }
})

vi.mock('../db/schema.js', () => ({
  wikis: { deletedAt: 'wikis.deleted_at' },
  entries: { deletedAt: 'entries.deleted_at' },
  fragments: { deletedAt: 'fragments.deleted_at' },
  people: { deletedAt: 'people.deleted_at' },
  edges: { deletedAt: 'edges.deleted_at' },
}))

const { buildExportZip } = await import('./export-zip.js')

async function streamToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function unzipEntries(buf: Buffer): Promise<Map<string, string>> {
  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('no zip'))
      const out = new Map<string, string>()
      zip.readEntry()
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) return reject(e2 ?? new Error('no stream'))
          const parts: Buffer[] = []
          rs.on('data', (d) => parts.push(d))
          rs.on('end', () => {
            out.set(entry.fileName, Buffer.concat(parts).toString('utf8'))
            zip.readEntry()
          })
        })
      })
      zip.on('end', () => resolve(out))
      zip.on('error', reject)
    })
  })
}

describe('buildExportZip', () => {
  beforeEach(() => vi.clearAllMocks())

  it('produces a zip with the documented layout', async () => {
    const archive = await buildExportZip()
    const buf = await streamToBuffer(archive as unknown as Readable)
    const entries = await unzipEntries(buf)

    expect([...entries.keys()].sort()).toEqual([
      'entries/entry_xyz.md',
      'fragments.json',
      'graph.json',
      'manifest.json',
      'people.json',
      'wikis/wiki-one.md',
    ])
  })

  it('manifest has correct counts and version', async () => {
    const archive = await buildExportZip()
    const entries = await unzipEntries(await streamToBuffer(archive as unknown as Readable))
    const manifest = JSON.parse(entries.get('manifest.json')!)
    expect(manifest.version).toBe(1)
    expect(manifest.counts).toEqual({
      wikis: 1,
      entries: 1,
      fragments: 1,
      people: 1,
      edges: 1,
    })
    expect(typeof manifest.exportedAt).toBe('string')
  })

  it('strips embeddings from fragments and people JSON', async () => {
    const archive = await buildExportZip()
    const entries = await unzipEntries(await streamToBuffer(archive as unknown as Readable))
    const fragments = JSON.parse(entries.get('fragments.json')!)
    const people = JSON.parse(entries.get('people.json')!)
    expect(fragments[0]).not.toHaveProperty('embedding')
    expect(fragments[0]).not.toHaveProperty('searchVector')
    expect(people[0]).not.toHaveProperty('embedding')
  })

  it('graph.json uses canonical type:id node ids and src/dst edge form', async () => {
    const archive = await buildExportZip()
    const entries = await unzipEntries(await streamToBuffer(archive as unknown as Readable))
    const graph = JSON.parse(entries.get('graph.json')!)
    expect(graph.nodes).toContainEqual({
      id: 'wiki:wiki_aaa',
      type: 'wiki',
      label: 'Wiki One',
    })
    expect(graph.edges[0]).toMatchObject({
      src: 'fragment:frag_111',
      dst: 'wiki:wiki_aaa',
      edgeType: 'FRAGMENT_IN_WIKI',
    })
  })

  it('wiki markdown carries frontmatter and body', async () => {
    const archive = await buildExportZip()
    const entries = await unzipEntries(await streamToBuffer(archive as unknown as Readable))
    const md = entries.get('wikis/wiki-one.md')!
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('name: Wiki One')
    expect(md).toContain('# Wiki One')
    expect(md).toContain('Body text.')
  })
})

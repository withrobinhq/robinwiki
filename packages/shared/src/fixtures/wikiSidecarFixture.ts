/**
 * Exhaustive wiki sidecar fixture — Transformer architecture.
 *
 * One sample that doubles as (a) the canonical preview/design target for the
 * wiki renderer and (b) the onboarding sample a new user sees on first run.
 * Content mirrors Vaswani et al.'s "Attention Is All You Need" (2017) so the
 * prose carries real weight rather than placeholder copy.
 *
 * The fixture exercises every affordance of the wiki detail surface:
 * - every token kind (`person`, `fragment`, `wiki`, `entry`)
 * - a deliberately unresolvable token (`[[person:anonymous-reviewer]]`) so
 *   the renderer can prove its graceful-drop / raw-text fallback
 * - duplicate heading producing `notes` + `notes-1` anchors
 * - headings at levels 1, 2, and 3
 * - one section with two populated citations (fragmentId, fragmentSlug,
 *   quote, capturedAt), and additional sections with empty citation arrays
 * - infobox with image, caption, and rows covering every `valueKind`
 *   (`text`, `ref`, `date`, `status`)
 * - refs map entries for every kind (person, fragment, wiki, entry)
 *
 * Consumed by:
 * - `GET /preview/wiki/fixture` in `core/src/routes/preview.ts` — canonical
 *   public design sample for the frontend renderer
 * - `POST /preview/wiki` fallback ref resolver — when a caller's
 *   `refsOverride` misses, we fall back to these refs
 * - Prompt/generator regression tests that need a known-good shape
 * - Seed script + bootstrap flow (downstream phases) — a new user's first
 *   wiki is populated from this object
 */

import type {
  WikiCitation,
  WikiInfobox,
  WikiRef,
  WikiSection,
} from '../schemas/sidecar.js'

/**
 * Raw markdown body for the fixture. Exported separately so `POST /preview/wiki`
 * can use it as a sane default, tests can re-parse it through `buildSidecar`,
 * and the downstream seed script can write it to disk/DB without re-inlining.
 */
export const fixtureMarkdown = `# Transformer Architecture

The Transformer is a sequence-to-sequence model introduced by [[person:ashish-vaswani]], [[person:noam-shazeer]], and [[person:niki-parmar]] (with others) in [[entry:attention-paper-abstract]]. It discards recurrence entirely in favour of attention, which makes training dramatically more parallelisable. The original paper is available as [[wiki:attention-is-all-you-need]].

## Overview

The core claim is [[fragment:self-attention-replaces-recurrence]]: a stack of self-attention layers can model long-range dependencies without the sequential bottleneck of an RNN. Paired with [[fragment:multi-head-attention-parallelism]], the architecture is able to attend to information from different representation subspaces at different positions simultaneously.

### The Attention Mechanism

Attention is computed as a weighted sum of values, where the weight on each value is a compatibility function between a query and the corresponding key. The specific variant used here is [[fragment:scaled-dot-product-attention]], which divides the dot products by the square root of the key dimension to keep gradients well-behaved.

## Architecture

[[fragment:encoder-decoder-stacks]] — both encoder and decoder are a stack of N=6 identical layers. [[fragment:positional-encoding-sequence-order]] is added to the input embeddings so the model has access to order information despite the lack of recurrence or convolution.

### Encoder Stack

Each encoder layer has two sub-layers: a multi-head self-attention mechanism and a position-wise fully connected feed-forward network. Residual connections surround each sub-layer, followed by layer normalization.

### Decoder Stack

The decoder inserts a third sub-layer that performs multi-head attention over the encoder's output. The decoder's self-attention is masked to prevent positions from attending to subsequent positions, preserving the autoregressive property.

## Notes

A note from [[person:anonymous-reviewer]]: the paper's scalability results generalize far beyond translation, though the original benchmarks focused on WMT 2014 English-to-German and English-to-French.

## Notes

Duplicate heading on purpose — the renderer should disambiguate this anchor as \`notes-1\`.
`

const refs: Record<string, WikiRef> = {
  'person:ashish-vaswani': {
    kind: 'person',
    id: 'p-ashish-vaswani',
    slug: 'ashish-vaswani',
    label: 'Ashish Vaswani',
    relationship: "Co-author of 'Attention Is All You Need'",
  },
  'person:noam-shazeer': {
    kind: 'person',
    id: 'p-noam-shazeer',
    slug: 'noam-shazeer',
    label: 'Noam Shazeer',
    relationship: "Co-author of 'Attention Is All You Need'",
  },
  'person:niki-parmar': {
    kind: 'person',
    id: 'p-niki-parmar',
    slug: 'niki-parmar',
    label: 'Niki Parmar',
    relationship: "Co-author of 'Attention Is All You Need'",
  },
  'fragment:self-attention-replaces-recurrence': {
    kind: 'fragment',
    id: 'f-self-attention-replaces-recurrence',
    slug: 'self-attention-replaces-recurrence',
    label: 'Self-attention replaces recurrence',
    snippet: 'A stack of self-attention layers models long-range dependencies without the sequential bottleneck of an RNN.',
  },
  'fragment:multi-head-attention-parallelism': {
    kind: 'fragment',
    id: 'f-multi-head-attention-parallelism',
    slug: 'multi-head-attention-parallelism',
    label: 'Multi-head attention enables parallelism',
    snippet: 'Running attention h times in parallel lets the model attend to different representation subspaces at different positions.',
  },
  'fragment:positional-encoding-sequence-order': {
    kind: 'fragment',
    id: 'f-positional-encoding-sequence-order',
    slug: 'positional-encoding-sequence-order',
    label: 'Positional encoding injects sequence order',
    snippet: 'Since the architecture has no recurrence or convolution, sinusoidal positional encodings are added to embeddings to convey order.',
  },
  'fragment:scaled-dot-product-attention': {
    kind: 'fragment',
    id: 'f-scaled-dot-product-attention',
    slug: 'scaled-dot-product-attention',
    label: 'Scaled dot-product attention',
    snippet: 'Attention(Q, K, V) = softmax(QKᵀ / √d_k) V — the scaling factor keeps gradients stable for large key dimensions.',
  },
  'fragment:encoder-decoder-stacks': {
    kind: 'fragment',
    id: 'f-encoder-decoder-stacks',
    slug: 'encoder-decoder-stacks',
    label: 'Encoder and decoder stacks of N=6 layers',
    snippet: 'Both the encoder and decoder are a stack of six identical layers, each with residual connections and layer normalization.',
  },
  'wiki:attention-is-all-you-need': {
    kind: 'wiki',
    id: 'w-attention-is-all-you-need',
    slug: 'attention-is-all-you-need',
    label: 'Attention Is All You Need (paper)',
    wikiType: 'reference',
  },
  'entry:attention-paper-abstract': {
    kind: 'entry',
    id: 'e-attention-paper-abstract',
    slug: 'attention-paper-abstract',
    label: 'Abstract — Attention Is All You Need',
    createdAt: '2017-06-12',
  },
  // NOTE: `person:anonymous-reviewer` is intentionally absent from this map.
  // The markdown references the token so the renderer can prove its graceful
  // drop / raw-text fallback for unresolved references.
}

// Only the fixture populates `infobox.image` — see wikiInfoboxSchema.image
// JSDoc (issue #160). The LLM pipeline never emits it; a multi-modal
// phase will later. The SVG below is a simplified redraw of Vaswani
// et al. Figure 1 (no copyright exposure), shipped at
// wiki/public/images/transformer-architecture.svg.
const infobox: WikiInfobox = {
  image: {
    url: '/images/transformer-architecture.svg',
    alt: 'Encoder-decoder architecture diagram, simplified from the Transformer paper',
  },
  caption: 'Encoder-decoder architecture — redrawn from Vaswani et al. (2017).',
  rows: [
    { label: 'Status', value: 'complete', valueKind: 'status' },
    { label: 'Paper', value: 'Attention Is All You Need', valueKind: 'text' },
    { label: 'Lead author', value: '[[person:ashish-vaswani]]', valueKind: 'ref' },
    { label: 'Published', value: '2017-06-12', valueKind: 'date' },
  ],
}

const overviewCitations: WikiCitation[] = [
  {
    fragmentId: 'f-self-attention-replaces-recurrence',
    fragmentSlug: 'self-attention-replaces-recurrence',
    quote: 'A stack of self-attention layers models long-range dependencies without the sequential bottleneck of an RNN.',
    capturedAt: '2017-06-12',
  },
  {
    fragmentId: 'f-multi-head-attention-parallelism',
    fragmentSlug: 'multi-head-attention-parallelism',
    quote: 'Running attention h times in parallel lets the model attend to different representation subspaces at different positions.',
    capturedAt: '2017-06-12',
  },
]

const architectureCitations: WikiCitation[] = [
  {
    fragmentId: 'f-encoder-decoder-stacks',
    fragmentSlug: 'encoder-decoder-stacks',
    quote: 'Both the encoder and decoder are a stack of six identical layers.',
    capturedAt: '2017-06-12',
  },
  {
    fragmentId: 'f-positional-encoding-sequence-order',
    fragmentSlug: 'positional-encoding-sequence-order',
    quote: 'Since the architecture has no recurrence or convolution, sinusoidal positional encodings are added to embeddings to convey order.',
    capturedAt: '2017-06-12',
  },
]

const sections: WikiSection[] = [
  // H1 — emitted as a section so renderers that honour top-level headings
  // still see a level-1 entry.
  {
    id: 'transformer-architecture',
    anchor: 'transformer-architecture',
    heading: 'Transformer Architecture',
    level: 1,
    citations: [],
  },
  {
    id: 'overview',
    anchor: 'overview',
    heading: 'Overview',
    level: 2,
    citations: overviewCitations,
  },
  {
    id: 'the-attention-mechanism',
    anchor: 'the-attention-mechanism',
    heading: 'The Attention Mechanism',
    level: 3,
    citations: [],
  },
  {
    id: 'architecture',
    anchor: 'architecture',
    heading: 'Architecture',
    level: 2,
    citations: architectureCitations,
  },
  {
    id: 'encoder-stack',
    anchor: 'encoder-stack',
    heading: 'Encoder Stack',
    level: 3,
    citations: [],
  },
  {
    id: 'decoder-stack',
    anchor: 'decoder-stack',
    heading: 'Decoder Stack',
    level: 3,
    citations: [],
  },
  {
    id: 'notes',
    anchor: 'notes',
    heading: 'Notes',
    level: 2,
    citations: [],
  },
  {
    id: 'notes-1',
    anchor: 'notes-1',
    heading: 'Notes',
    level: 2,
    citations: [],
  },
]

/**
 * Full wiki detail payload shaped to match `wikiDetailResponseSchema` from
 * `core/src/schemas/wikis.schema.ts`. Dates are emitted as ISO strings — the
 * schema uses `z.coerce.date()` and accepts them without ceremony.
 */
export const wikiSidecarFixture = {
  // ── Thread/wiki core fields ─────────────────────────────────────
  id: 'wiki-transformer-architecture',
  lookupKey: 'wiki-transformer-architecture',
  slug: 'transformer-architecture',
  name: 'Transformer Architecture',
  type: 'project',
  prompt: '',
  state: 'RESOLVED' as const,
  lastRebuiltAt: '2017-06-12T00:00:00.000Z',
  createdAt: '2017-06-12T00:00:00.000Z',
  updatedAt: '2017-06-12T00:00:00.000Z',
  noteCount: 5,
  lastUpdated: '2017-06-12T00:00:00.000Z',
  shortDescriptor: 'Attention-only sequence-to-sequence architecture',
  descriptor:
    'A walkthrough of the Transformer, the architecture that replaced recurrence with attention and set the foundation for modern large language models.',
  progress: null,

  // ── Wiki detail fields ──────────────────────────────────────────
  wikiContent: fixtureMarkdown,
  content: fixtureMarkdown,
  fragments: [
    {
      id: 'f-self-attention-replaces-recurrence',
      slug: 'self-attention-replaces-recurrence',
      title: 'Self-attention replaces recurrence',
      snippet:
        'A stack of self-attention layers models long-range dependencies without the sequential bottleneck of an RNN.',
    },
    {
      id: 'f-multi-head-attention-parallelism',
      slug: 'multi-head-attention-parallelism',
      title: 'Multi-head attention enables parallelism',
      snippet:
        'Running attention h times in parallel lets the model attend to different representation subspaces at different positions.',
    },
    {
      id: 'f-positional-encoding-sequence-order',
      slug: 'positional-encoding-sequence-order',
      title: 'Positional encoding injects sequence order',
      snippet:
        'Sinusoidal positional encodings are added to embeddings so the model has access to order information.',
    },
    {
      id: 'f-scaled-dot-product-attention',
      slug: 'scaled-dot-product-attention',
      title: 'Scaled dot-product attention',
      snippet:
        'Attention(Q, K, V) = softmax(QKᵀ / √d_k) V — the scale factor stabilises gradients for large key dimensions.',
    },
    {
      id: 'f-encoder-decoder-stacks',
      slug: 'encoder-decoder-stacks',
      title: 'Encoder and decoder stacks of N=6 layers',
      snippet:
        'Both the encoder and decoder are a stack of six identical layers with residual connections and layer normalization.',
    },
  ],
  people: [
    { id: 'p-ashish-vaswani', name: 'Ashish Vaswani' },
    { id: 'p-noam-shazeer', name: 'Noam Shazeer' },
    { id: 'p-niki-parmar', name: 'Niki Parmar' },
  ],

  // ── Sidecar (m-wiki-sidecar) ────────────────────────────────────
  refs,
  infobox,
  sections,
}

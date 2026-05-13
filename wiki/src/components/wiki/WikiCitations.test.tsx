import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { WikiCitations } from './WikiCitations'
import type { WikiCitation } from '@/lib/sidecarTypes'

afterEach(cleanup)

const citations: WikiCitation[] = [
  {
    fragmentId: 'f-self-attention-replaces-recurrence',
    fragmentSlug: 'self-attention-replaces-recurrence',
    quote: 'Self-attention replaces recurrence.',
    capturedAt: '2017-06-12',
  },
  {
    fragmentId: 'f-multi-head-attention-parallelism',
    fragmentSlug: 'multi-head-attention-parallelism',
    quote: 'Running attention h times in parallel.',
    capturedAt: '2017-06-12',
  },
]

describe('<WikiCitations>', () => {
  it('renders a superscript per citation with per-section 1-based numbering', () => {
    const { container } = render(<WikiCitations citations={citations} />)
    const sups = container.querySelectorAll('sup[data-slot="wiki-citation"]')
    expect(sups).toHaveLength(2)
    expect(screen.getByText('[1]')).toBeInTheDocument()
    expect(screen.getByText('[2]')).toBeInTheDocument()
  })

  it('links each superscript to the in-page #fragment-{lookupKey} anchor (#245)', () => {
    const { container } = render(<WikiCitations citations={citations} />)
    const anchors = container.querySelectorAll('sup[data-slot="wiki-citation"] a')
    expect(anchors).toHaveLength(2)
    expect(anchors[0].getAttribute('href')).toBe(
      '#fragment-f-self-attention-replaces-recurrence',
    )
    expect(anchors[1].getAttribute('href')).toBe(
      '#fragment-f-multi-head-attention-parallelism',
    )
  })

  it('honours startIndex for running document-wide numbering', () => {
    const { container } = render(<WikiCitations citations={citations} startIndex={5} />)
    expect(screen.getByText('[5]')).toBeInTheDocument()
    expect(screen.getByText('[6]')).toBeInTheDocument()
    const sups = container.querySelectorAll('sup[data-slot="wiki-citation"]')
    expect(sups).toHaveLength(2)
  })

  it('uses citationMap numbers when provided, ignoring startIndex', () => {
    const citationMap = new Map<string, number>([
      ['f-self-attention-replaces-recurrence', 3],
      ['f-multi-head-attention-parallelism', 7],
    ])
    const { container } = render(
      <WikiCitations citations={citations} citationMap={citationMap} startIndex={99} />,
    )
    expect(screen.getByText('[3]')).toBeInTheDocument()
    expect(screen.getByText('[7]')).toBeInTheDocument()
    const sups = container.querySelectorAll('sup[data-slot="wiki-citation"]')
    expect(sups).toHaveLength(2)
  })

  it('falls back to startIndex for fragments missing from citationMap', () => {
    const citationMap = new Map<string, number>([
      ['f-self-attention-replaces-recurrence', 4],
      // second fragment deliberately absent
    ])
    render(
      <WikiCitations citations={citations} citationMap={citationMap} startIndex={10} />,
    )
    // first citation found in map
    expect(screen.getByText('[4]')).toBeInTheDocument()
    // second citation not in map, falls back to startIndex + i = 10 + 1
    expect(screen.getByText('[11]')).toBeInTheDocument()
  })

  it('renders nothing when citations array is empty', () => {
    const { container } = render(<WikiCitations citations={[]} />)
    // Component returns null on empty input; the render root holds no children.
    expect(container.firstChild).toBeNull()
  })

  it('applies caller-provided className to the wrapper span', () => {
    const { container } = render(
      <WikiCitations citations={citations} className="custom-citations" />,
    )
    const wrapper = container.querySelector('span[data-slot="wiki-citations"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('custom-citations')
  })
})

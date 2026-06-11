import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// ── Mocks ────────────────────────────────────────────────────────────────
//
// `WikiEntityArticle` pulls a heavy tree (AddWikiModal, InlineEditor,
// WikiHistoryTimeline) plus a react-query-backed history hook. The Private
// badge logic is purely local — no network, no provider — so we stub every
// heavyweight dependency to keep the test focused on the published-state
// branch and avoid spinning up a QueryClientProvider for every assertion.

// WikiEntityArticle calls useRouter/usePathname/useSearchParams from
// next/navigation for tab-sync. Mock them here so tests run outside the
// App Router context without the "invariant expected app router to be
// mounted" error.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/wiki/test',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/layout/AddWikiModal', () => ({
  __esModule: true,
  default: () => null,
}))

vi.mock('@/components/editor/InlineEditor', () => ({
  __esModule: true,
  default: () => null,
}))

vi.mock('@/components/wiki/WikiHistoryTimeline', () => ({
  __esModule: true,
  default: () => null,
}))

vi.mock('@/hooks/useWikiEditHistory', () => ({
  useWikiEditHistory: () => ({ data: undefined }),
}))

import { WikiEntityArticle } from './WikiEntityArticle'

afterEach(cleanup)

// Minimal infobox config — `simple` is the most common variant on real wiki
// pages. The component renders this via `WikiInfoboxTypeUpdated`; we don't
// assert on it here.
const infobox = {
  kind: 'simple' as const,
  typeLabel: 'Log',
  lastUpdated: new Date('2026-05-01').toISOString(),
  showSettings: false,
}

describe('<WikiEntityArticle> Private badge', () => {
  it('renders the Private badge when published === false', () => {
    render(
      <WikiEntityArticle
        chipLabel="Log"
        title="Engineering Log"
        infobox={infobox}
        published={false}
      >
        <p>body</p>
      </WikiEntityArticle>,
    )
    const badge = screen.getByTestId('wiki-private-badge')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toBe('Private')
  })

  it('does NOT render the Private badge when published === true', () => {
    render(
      <WikiEntityArticle
        chipLabel="Log"
        title="Engineering Log"
        infobox={infobox}
        published={true}
      >
        <p>body</p>
      </WikiEntityArticle>,
    )
    expect(screen.queryByTestId('wiki-private-badge')).toBeNull()
  })

  it('does NOT render the Private badge when published is undefined (caller-omitted)', () => {
    // Callers that don't yet wire the `published` prop must not unexpectedly
    // surface a Private label. The badge fires only on the explicit `false`
    // signal so prototype/preview pages stay clean.
    render(
      <WikiEntityArticle
        chipLabel="Log"
        title="Engineering Log"
        infobox={infobox}
      >
        <p>body</p>
      </WikiEntityArticle>,
    )
    expect(screen.queryByTestId('wiki-private-badge')).toBeNull()
  })
})

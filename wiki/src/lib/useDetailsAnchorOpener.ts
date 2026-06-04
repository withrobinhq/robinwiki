'use client'

import { useEffect } from 'react'

/**
 * Open any ancestor `<details>` elements when an anchor target inside
 * them is referenced via `window.location.hash`.
 *
 * Why this exists: the wiki detail page renders its Citations list
 * inside a collapsed `<details>` (so the footnote section doesn't
 * dominate the chrome). Each `<li>` carries `id="fragment-{lookupKey}"`
 * so the `[N]` superscript anchors in the body can jump to the row.
 *
 * Chrome auto-opens an enclosing `<details>` when an anchor inside it
 * is targeted via hash navigation. **Safari does not.** The result:
 * clicking a citation footnote on Safari changes the URL hash but the
 * page does nothing — the target `<li>` is hidden inside the closed
 * `<details>`, so there's nothing to scroll to.
 *
 * The hook runs:
 *  - Once on mount, so deep-linking to `/wiki/abc#fragment-xyz` works.
 *  - On every `hashchange` event, so in-page citation clicks work.
 *
 * After opening the details, scroll is deferred one animation frame so
 * the layout shift from the now-expanded section settles before
 * `scrollIntoView` measures.
 */
export function useDetailsAnchorOpener(): void {
  useEffect(() => {
    function openAndScrollToHash() {
      if (typeof window === 'undefined') return
      const hash = window.location.hash
      if (!hash || hash.length < 2) return

      const id = hash.slice(1)
      const target = document.getElementById(id)
      if (!target) return

      // Walk up through every ancestor <details>, opening any that are
      // currently closed. The direct `closest('details')` handles the
      // one-level case; the loop handles deeper nesting.
      //
      // Track whether we actually opened anything. If every ancestor
      // was already open, the browser has already handled this anchor
      // navigation natively (Chrome / Edge / newer Firefox), so we
      // skip the explicit scroll to avoid a flicker on top of the
      // browser's native scroll. We only intervene when there was a
      // closed disclosure hiding the target — which is the Safari
      // case this hook exists for.
      let openedAny = false
      let cursor: HTMLElement | null = target.closest('details')
      while (cursor instanceof HTMLDetailsElement) {
        if (!cursor.open) {
          cursor.open = true
          openedAny = true
        }
        cursor = cursor.parentElement?.closest('details') ?? null
      }

      if (!openedAny) return

      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }

    openAndScrollToHash()
    window.addEventListener('hashchange', openAndScrollToHash)
    return () => window.removeEventListener('hashchange', openAndScrollToHash)
  }, [])
}

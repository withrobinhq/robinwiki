# Seed Data

Robin ships one piece of seed data: the Transformer demo wiki. It is
the only path that writes domain rows outside of the user's own ingest
flow.

## What the seed produces

`core/src/lib/seedFixture.ts` materialises a fixture rooted at
`packages/shared/src/fixtures/wikiSidecarFixture.ts`, mirroring Vaswani
et al.'s "Attention Is All You Need" abstract so a fresh Robin
instance has something concrete to render on first sign-in.

One run produces:

- 1 wiki (`attention-is-all-you-need`).
- 3 people (`ashish-vaswani`, `noam-shazeer`, `niki-parmar`),
  inserted with `verified=false`, `state='RESOLVED'`.
- 5 fragments, 1 entry (`source='seed'`).
- 5 ENTRY_HAS_FRAGMENT edges (`src_type='raw_source'`).
- 5 FRAGMENT_IN_WIKI edges (`attrs.method='seed'`).
- 15 FRAGMENT_MENTIONS_PERSON edges (3 people times 5 fragments).

The 15 mention edges are the rows QA Issue 4c flagged as appearing
before any entity-extract pipeline event. They are the seed-fixture
write, not pipeline output.

## When it fires

`core/src/bootstrap/seed-demo-wiki.ts` calls `seedFixture()` from
first-user provisioning. Single-tenant, so first-user equals fresh
instance. Gate is `isFixtureSeeded()` (slug presence on the wiki row).
A user who deletes the demo wiki does not get it re-seeded.

The CLI script `core/scripts/seed-fixture.ts` (`pnpm -C core
seed-fixture`) runs the same library function for development.

## Reproducibility

Reproducible. Both call sites import the same function, the projection
is pure, and re-running updates in place. Existence lookups ignore
`deletedAt` so soft-deleted rows resurrect under the same slug.

## Interaction with Stream P quarantine

The seed inserts people with `verified=false` directly, bypassing
`resolvePerson` and any future auto-accept gating. If Stream P needs
to exclude seeded people from a quarantine queue, the cleanest signal
today is `FRAGMENT_IN_WIKI.attrs.method='seed'` on the corresponding
fragment edges.

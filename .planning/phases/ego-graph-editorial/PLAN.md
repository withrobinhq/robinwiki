# Ego Graph Editorial — Phase 1

## Goal
Ship the editorial SVG ego graph view as an additive feature in `wiki/`. Concentric ring
layout, scholarly typography, real data, new route `/graph/ego/[id]`.

## Out of scope (Phase 2+)
- Backend `GET /graph/ego/:id` BFS endpoint (use existing `/graph?wikiId=X` for now)
- Decommissioning `GraphCanvas.tsx`
- Tests / Storybook
- Accessibility audit

## File tree
wiki/src/components/ego-graph-editorial/
├── EgoGraphEditorial.tsx
├── EgoGraphEditorial.module.css
├── components/
│   ├── Stage.tsx
│   ├── Sidebar.tsx
│   ├── DetailPanel.tsx
│   ├── Tooltip.tsx
│   └── TopBar.tsx
├── lib/
│   ├── layout.ts
│   ├── colors.ts
│   ├── nodeShapes.tsx
│   ├── edgeRouting.ts
│   └── hash.ts
├── hooks/
│   └── useEgoGraphState.ts
├── types.ts
└── index.ts

wiki/src/app/(shell)/graph/ego/[id]/page.tsx

## Acceptance
- `pnpm tsc --noEmit` passes in `wiki/`
- `pnpm lint` passes in `wiki/`
- Dev server boots, `/graph/ego/<any wiki id>` renders editorial layout with real data
- No edits to existing GraphCanvas, /graph endpoint, or schema

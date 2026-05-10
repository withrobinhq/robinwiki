# Ego Graph Editorial, Closure Plan

Status: target visual is `sclip.png` (the user's reference render).
Current: the editorial port is structurally complete but visually flat.
This plan covers every scenario between here and "we are there", explicitly
flags the decisions that need user input, and documents what is parked
for follow-up phases.

---

## 1. Reality check, visual diff vs sclip.png

A side-by-side audit of the rendered output at
`/graph/ego/<wiki_id>` against `sclip.png` after the rhythm fix
(commit `d865d3e`):

| Pillar                      | sclip (target)                                                   | current                                                              | gap source                                |
| --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| Node color palette          | distinct subtype colors per wiki, hint colors on fragments        | uniform `#1e2939` on every wiki, generic grey on fragments          | DATA: `/api/graph` does not emit subtype  |
| Focus prominence            | bold filled blue, dashed pulsing ring, four cross marks, halo    | small filled circle, faint dashed ring, cross marks barely visible  | RENDER + ANIM: focus styles too soft      |
| Stage proportions           | stage clearly dominant, sidebar narrower, detail comparable      | sidebar 280px wins visual weight                                    | LAYOUT: column widths                     |
| Density                     | many nodes filling all three rings                               | sparse (3 wikis, 60 fragments in local DB)                          | DATA: corpus dependent, not a code bug    |
| Fragment halos              | dashed outer halo at hop-1 fragments visible                     | rendered but at opacity that disappears against paper-2             | RENDER: opacity tuning                    |
| Edge differentiation        | filing grey, wikilink blue, mention dashed tan, all distinct     | three classes wired but reads uniform at small zoom                 | RENDER: stroke widths / opacities         |
| Hover dimming               | non-neighbors fade hard, neighbor edges hot                      | wired, untested visually under sparse data                          | VERIFICATION                              |
| Hop opacity tiers           | hop 2 at .78, hop 3 at .5, focus and hop-1 at full               | constant set in Stage but verify class wiring                       | VERIFICATION                              |
| Zoom controls               | 4 buttons: in, out, fit, reset                                   | 3 buttons: in, out, reset                                           | RENDER: missing button + fit math         |
| Stage corner labels         | mono uppercase 0.18em with variant text per corner               | rendered but slightly different separator dot                       | RENDER: micro typography                  |
| Animations                  | focus ring pulse, fade-in on first paint                         | keyframes defined, verify wiring                                    | VERIFICATION                              |
| Top bar segmented           | List, Wiki, Ego graph (active black)                             | rendered correctly                                                  | none                                      |
| Sidebar focus card          | "BELIEF · WIKI" tag                                              | "WIKI · WIKI" because no subtype                                    | DATA: subtype, see palette                |
| Sidebar subtype legend      | 10 colored dots                                                  | rendered with correct colors (legend is independent of node data)   | none                                      |
| Detail title                | 24px STIX serif, -0.015em, dark                                  | rendered                                                            | none                                      |
| Detail summary highlights   | inline `<em>` blue italic on key phrases ("high confidence" etc) | inline `<em>` on counts ("4 direct connections")                    | COPY: summary generation                  |
| Detail provenance           | id, created, last edit, last reindex, vault                      | id, type, hop, vault (no timestamps)                                | DATA: graph payload has no timestamps     |
| Direct connections list     | up to 9 rows, dot + serif title + mono subtype                   | rendered, dot color falls back without subtype                      | DATA: subtype                             |
| Tooltip                     | positioned, dot + type + hop, title, meta                        | rendered, may overflow viewport edges                               | POLISH: edge clamping                     |
| Breadcrumb middle slot      | "Beliefs" derived from focus subtype                             | "Wikis" hardcoded plural fallback                                   | DATA: subtype                             |

**Read of the table:** ten of the gaps trace back to one cause (subtype
not in the API payload). Fix that first and roughly half the perceived
"flatness" disappears for free. Everything else is render polish.

---

## 2. Root causes, ranked by leverage

1. **Subtype absent from the graph API.** `core/src/routes/graph.ts`
   serializes wiki nodes with `type: 'wiki'` but does not include the
   `wikis.type` value (which holds the editorial subtype, one of
   belief/decision/goal/project/principle/log/collection/skill/agent/voice).
   Without it the client palette is unreachable. Affects:
   node fill color, focus card tag, conn-list dots, detail pretitle dot,
   breadcrumb middle slot, sidebar subtype filtering accuracy, summary
   copy plausibility.

2. **Focus visual treatment lost intensity in the port.** Reference
   focus is a multi-layer composition (translucent halo, solid filled,
   inner stroked + white border, dashed pulsing outer ring, four cross
   tick marks). The current `renderFocus` emits the structure but the
   CSS rules for `.focusRing`, `.focusCross`, and the inner halo opacity
   landed below thresholds where they read on screen.

3. **Edge stroke fidelity.** The three kinds map to three classes but
   stroke widths land at the same visual register. Reference fades all
   edges to a soft baseline and lifts hot edges with `stroke-width: 1.6`.
   The width contrast and the .filing baseline opacity (.35 in the
   reference, may be too light against paper-2) need calibration.

4. **Stage column proportions.** Current `.app` grid is
   `280px 1fr 360px`. Reference reads narrower sidebar (~240) and a
   tighter detail (~340) so the stage commands more horizontal area.
   Visual weight matters here because the stage is the artifact.

5. **Hop opacity tiers may not be applied via CSS.** Stage assigns
   `hopOpacity` as an SVG `opacity` attribute on the wrapper `<g>` per
   node, which is correct. Verify it survives the hover dim cascade
   (where `.isDim { opacity: .18 }` may override).

6. **Missing fit-zoom button.** The reference shows four zoom controls;
   we ship three. Fit needs a real implementation (compute bbox over
   visible nodes, choose zoom that fits with margin, center the pan).

7. **Provenance copy honesty.** We omit timestamps because the graph
   payload doesn't carry them. Reference shows "created" and "last edit"
   timestamps. Either we extend the API or accept the omission.

8. **Tooltip overflow at edges.** Cursor-following position with
   `translate(-50%, -110%)` overflows when hovering nodes near the right
   or top edge. Needs clamping against viewport.

9. **Wheel zoom listener thrashing.** `useEffect` in Stage depends on
   `state.zoom`, so each zoom event tears down and re-attaches the
   wheel listener. Functionally correct, but compound rapid wheel
   events may apply against a stale `state.zoom` snapshot. Use a ref.

10. **CSS modules class export coverage.** Lightning CSS does export
    descendant-only class names from the module, verified empirically
    (`<span class="EgoGraphEditorial-module__4EVFxq__mark">` rendered
    in DOM). Earlier hypothesis that this was broken was wrong. No
    action needed; remove the four placeholder rulesets that were
    added defensively (`.bg`, `.halo`, `.frag`, `.person` and the
    new `.hopFar`).

---

## 3. Scenario coverage matrix

Across data shape, layout, interaction, performance, accessibility,
and lifecycle:

### 3.1 Data shape scenarios

| Scenario                                        | Current behavior                                          | Desired                                                     | Action                                  |
| ----------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Wiki node has subtype                           | not received from API                                     | render with SUBTYPE_COLOR[subtype]                          | extend API + client                     |
| Wiki node missing subtype (legacy)              | falls back to `#1e2939`                                   | same fallback                                                | already correct                         |
| Fragment has no `subtype`                       | falls back to `FRAGMENT_FALLBACK`                         | same                                                         | already correct                         |
| Fragment subtype is fact/idea/quote/observation | hint colors not wired                                     | apply hint color                                            | check fragment schema, plumb if exists  |
| Person has no edges                             | renders isolated at hop placement                         | same                                                         | acceptable, or hide                     |
| Entry-typed nodes                               | dropped client-side                                       | same                                                         | already correct                         |
| Edge with unmapped kind                         | dropped client-side                                       | same                                                         | already correct                         |
| Edge with self-loop                             | curve to same point, degenerate                           | hide or render as a loop                                    | drop in `EgoGraphPageClient` mapping    |
| Duplicate edges (A→B, B→A)                      | both render, may overlap                                  | de-dupe to one canonical                                    | de-dupe by sorted pair in mapping       |
| Focus has no neighbors                          | "no connections" empty state                              | same                                                         | already correct                         |
| Focus id missing from payload                   | error card                                                | same                                                         | already correct                         |
| 200+ nodes                                      | all render, layout sort O(n log n)                        | same                                                         | acceptable up to ~500                    |
| 1000+ nodes                                     | SVG path count noticeable, hover scans become slow        | virtualize or paginate                                       | out of scope; document threshold         |
| Very long label                                 | overflows visually                                        | truncate with ellipsis                                      | minor render tweak                      |
| Unicode / RTL label                             | renders, text-anchor middle holds                         | same                                                         | acceptable                              |

### 3.2 Layout / proportion scenarios

| Scenario                                | Current        | Desired                                | Action                                    |
| --------------------------------------- | -------------- | -------------------------------------- | ----------------------------------------- |
| Viewport ≥ 1280                         | 280/1fr/360    | ~240/1fr/340                           | adjust grid-template-columns              |
| Viewport 1024-1280                      | 280/1fr/360    | reduce sidebar to 220                  | media query                               |
| Viewport < 1024                         | grid breaks ergonomically | collapse to single column or hide one panel | media query, or accept and document |
| Viewport < 600                          | unusable        | accept, point user to canvas view      | document                                  |
| User resizes window mid-session         | grid reflows    | same                                    | already correct                           |

### 3.3 Interaction scenarios

| Scenario                                      | Current                                            | Desired                                            | Action                          |
| --------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| Click node                                    | SELECT dispatches, detail updates                  | same                                                | already correct                  |
| Click background                              | CLEAR_SELECT, detail returns to focus              | same                                                | already correct                  |
| Drag pan                                      | works                                              | same                                                | verify                          |
| Drag-then-release with no movement            | onClick may also fire and clear                    | drag should suppress click                         | minor: detect drag distance     |
| Wheel zoom                                    | works, listener thrash                             | smooth, no thrash                                  | switch to zoom ref              |
| Pinch zoom (touch)                            | not wired                                          | accept, document                                   | out of scope                    |
| Tab keyboard navigation                       | focusable elements traversable                     | landing on a node selects it                       | out of scope, document           |
| Esc clears selection                          | works                                              | same                                                | already correct                  |
| ⌘K opens search                               | not wired (placeholder)                            | accept, document                                   | out of scope                    |
| Click conn row                                | onNavigate dispatches SELECT                        | same                                                | already correct                  |
| Hover fragment near edge of stage             | tooltip overflows viewport                         | clamp                                              | polish                          |
| Hover during pan                              | tooltip and pan compete                            | suppress tooltip during pan                        | minor                           |
| Type filter all-off                           | activeTypes Set empty, focus survives              | same                                                | verify                          |
| Depth = 1 with very tight neighborhood        | layout still spreads                                | same                                                | acceptable                      |
| Depth = 3 with deep neighborhood              | ring 3 may collide                                  | accept, layout has angular jitter to spread        | acceptable                      |

### 3.4 Animation / micro-state scenarios

| Scenario                                | Current                                | Desired                                              | Action                                    |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| First paint                             | nodes appear instantly                 | fadeIn .4s                                           | verify keyframes wired on `.node`         |
| Focus ring pulse                        | static dashed ring                     | opacity oscillates .55 ↔ .85 over 4s                  | verify keyframes wired on `.focusRing`    |
| Edge transitions on hover               | snap                                   | smooth .15s opacity / stroke-width                   | verify rule                               |
| Node opacity on isDim                   | snap                                   | smooth                                                | verify rule                               |
| Pulse animation when reduced-motion     | runs                                   | respect `prefers-reduced-motion`                     | add @media query                          |

### 3.5 Performance scenarios

| Scenario                              | Threshold                            | Action                                  |
| ------------------------------------- | ------------------------------------ | --------------------------------------- |
| 50 nodes / 100 edges                   | trivial                              | none                                    |
| 200 nodes / 500 edges                  | fine                                 | none                                    |
| 500 nodes / 1500 edges                 | hover scans become noticeable        | memoize neighbor sets per hover, ok    |
| 1000+ nodes                            | SVG render bottleneck                | virtualize, document; out of scope     |
| Deep ring with many high-degree wikis  | label truncation collisions          | acceptable                              |
| Concurrent React re-renders            | useEffect deps thrash                | switch wheel listener to ref            |

### 3.6 Lifecycle / network scenarios

| Scenario                                          | Current                                    | Desired                                             | Action                              |
| ------------------------------------------------- | ------------------------------------------ | --------------------------------------------------- | ----------------------------------- |
| Page load while signed out                        | AuthGuard redirects                        | same                                                | already correct                     |
| Session expires mid-session                       | next API call returns 401                  | redirect via existing 401 handler                   | already correct                     |
| Network slow / loading                            | "Loading graph" placeholder                | match editorial copy/style                          | minor                               |
| Network fails                                     | error card with retry                      | same                                                | verify retry action                 |
| Empty graph (no neighbors)                        | empty state                                | same                                                | already correct                     |
| Wiki id 404 / not found                           | empty graph (no nodes match focus id)      | render error card                                   | improvement                         |
| Visit page while still loading wiki list          | spinner                                    | same                                                | already correct                     |

### 3.7 Accessibility scenarios (parked)

| Scenario                              | Current             | Desired                              | Action                |
| ------------------------------------- | ------------------- | ------------------------------------ | --------------------- |
| Screen reader landing                 | minimal landmarks    | nav/main/aside roles                  | out of scope          |
| Keyboard-only user                    | partial             | tab order, enter to select            | out of scope          |
| `prefers-reduced-motion`              | not honored          | suspend pulse + fade                  | small CSS add          |
| High contrast mode                    | not tested          | verify ink contrast                  | out of scope          |
| Color-blindness                       | edge kinds rely on color | shape + dash pattern (already on mention) | check enough  |

### 3.8 Failure modes / corner cases

| Mode                                      | Effect                                          | Mitigation                              |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| Subtype API field arrives but value is unrecognized | client falls back to default color | already correct                         |
| Server emits subtype but client wasn't regenerated  | TypeScript ignores unknown field   | field is optional, no breakage          |
| Client expects subtype but server doesn't emit yet  | falls back to current behavior      | already correct                         |
| `wikis.type` rename in DB after this work           | API serializer breaks               | covered by integration tests later      |
| Ego id is a fragment id, not a wiki                 | extractEgoSubgraph still works      | verify, may need icon for non-wiki focus |
| Graph endpoint times out                            | error card                          | already wired                           |
| User opens two tabs, edits state                    | independent reducers                | acceptable                              |

---

## 4. Per-change specifications

### 4.1 P0, subtype data flow

**Backend, `core/src/routes/graph.ts`** (read-only assertion: file path
inferred; verify location before editing):

- Source: `wikis.type` is already selected when listing wikis for graph
  serialization (verify by reading the route).
- Add `subtype: w.type ?? null` to the wiki node serializer.
- Schema: extend the wiki node response shape with optional
  `subtype: string | null`.
- Backward compat: field is optional, older clients ignore it.

**Schema, OpenAPI/manifest:**

- Regenerate `wiki/src/lib/generated/` so the wiki node type knows
  about `subtype`.
- Verify by running `pnpm -C core generate:openapi` (or the project's
  equivalent).

**Client, `wiki/src/app/(graph)/graph/ego/[id]/EgoGraphPageClient.tsx`:**

- In the wiki branch of node mapping, pass `n.subtype` through into the
  emitted `EgoNode`. The existing `nodeColor` already handles it.
- For non-wiki node types, leave `subtype` undefined; the fragment hint
  colors are a follow-up if `fragments.subtype` exists in the DB.

**Verification:**

- Hit `/api/graph` and confirm wiki nodes carry `subtype`.
- Reload `/graph/ego/<wiki id>` for a wiki of type "belief" and confirm
  the focus card tag reads "BELIEF · WIKI" not "WIKI · WIKI".
- Confirm node fill picks up `SUBTYPE_COLOR.belief` (#3366cc).

**Risk:**

- Forgetting to regenerate types → next push fails CI type check.
  Mitigation: include the regenerated file in the same commit.

**Effort:** 30 minutes (server change tiny, regen + verify).

### 4.2 P0, focus visual hardening

**`EgoGraphEditorial.module.css`:**

- `.focusRing`: `stroke: var(--blue); stroke-width: 1.5; stroke-dasharray: 3 5; fill: none; opacity: .65;` plus the pulse keyframes.
- `.focusCross`: `stroke: var(--blue); stroke-width: 1.2; opacity: .5;`.
- `.node.isFocus circle.bg`: ensure full opacity, no isDim override.
- Confirm `@keyframes pulse` exists with `0%, 100% { opacity: .55 } 50% { opacity: .85 }` and 4s ease-in-out infinite.
- Reduced motion: wrap in `@media (prefers-reduced-motion: no-preference)`.

**`lib/nodeShapes.tsx` `renderFocus`:**

- Drop the duplicate `<circle className={styles.halo} r={r + 8} />` at
  the end. The translucent halo at `r + 3 fill={color} opacity={.12}`
  already covers it.
- Reorder children so dashed ring sits behind the cross marks (z-order
  matters in SVG since later wins).

**Verification:**

- Visual: focus reads as the obvious anchor at any zoom 0.6-2.0.
- Pulse animates over 4s without flicker.
- Reduced-motion: ring sits at solid .8 opacity.

**Effort:** 20 minutes.

### 4.3 P1, stage column proportions

**`EgoGraphEditorial.module.css`:**

- `.app { grid-template-columns: 240px 1fr 340px; }` at default.
- `@media (max-width: 1280px) { .app { grid-template-columns: 220px 1fr 320px; } }`.
- `@media (max-width: 1024px) { .app { grid-template-columns: 200px 1fr 0; } .detail { display: none; } }` (parks the detail panel on narrow viewports; revisit).

**Verification:**

- 1600 wide: stage is the visual mass.
- 1280 wide: still legible.
- 1024 wide: detail panel hidden, no horizontal scroll.

**Effort:** 10 minutes.

### 4.4 P1, edge fidelity

**`EgoGraphEditorial.module.css`:**

- `.edge { stroke: var(--ink-4); stroke-width: .8; opacity: .45; transition: opacity .15s, stroke-width .15s; }`
- `.edge.filing { opacity: .35; }`
- `.edge.wikilink { stroke: var(--blue); opacity: .55; }`
- `.edge.mention { stroke: #8a7a4f; stroke-dasharray: 3 3; opacity: .5; }`
- `.edge.isDim { opacity: .08; }`
- `.edge.isHot { opacity: .95; stroke-width: 1.6; }`

These match the textual REFERENCE.md; verify they survived the port.

**Verification:**

- Hover a node and watch neighbor edges thicken. Non-neighbors fade hard.
- Mention edges show dashed, wikilink edges read blue.

**Effort:** 15 minutes (mostly verification, possibly a tweak).

### 4.5 P1, fit-zoom button

**`Stage.tsx`:**

- Compute bbox over current `nodes` (post-filter by depth/type).
- `fitZoom = min(W / bboxW, H / bboxH) * 0.9`.
- Center pan: `panX = (W/2 - bboxCx) * fitZoom; panY = (H/2 - bboxCy) * fitZoom`.
  Adjust for SVG viewBox semantics.
- Wire as a 4th button in `.stageTools`. Icon: `⤢` or "fit".

**Verification:**

- Click fit at any pan/zoom; graph centers and fits with margin.

**Effort:** 30 minutes.

### 4.6 P1, hop opacity tiering check

**`Stage.tsx`:**

- The current `<g opacity={hopOpacity}>` is wrapped further outside in
  the renderedNodes group. Verify the hover dim class (`isDim`) cascades
  to override hopOpacity (it should, because `.node.isDim { opacity: .18 }`
  on a parent supersedes a child's `opacity` attr).

**Verification:**

- Hop 3 nodes appear at .5 opacity by default.
- On hover of a hop-1 node, hop-3 non-neighbors drop to .18.

**Effort:** 5 minutes verification.

### 4.7 P2, tooltip clamping

**`EgoGraphEditorial.tsx` or `Tooltip.tsx`:**

- Clamp `screenX` to `[80, viewportWidth - 80]`.
- Clamp `screenY` to `[60, viewportHeight - 40]`.
- Adjust `transform` so the bottom edge of the tooltip doesn't go
  off-screen.

**Effort:** 10 minutes.

### 4.8 P2, drag-vs-click discrimination

**`Stage.tsx`:**

- Track whether pointer moved more than 4px between pointerDown and
  pointerUp.
- If yes, suppress the click on pointerUp.

**Effort:** 10 minutes.

### 4.9 P2, wheel zoom ref

**`Stage.tsx`:**

- Store latest `state.zoom` in a ref updated each render.
- Wheel listener reads `zoomRef.current` instead of closure-captured.
- Drop `state.zoom` from useEffect deps.

**Effort:** 10 minutes.

### 4.10 P2, drop redundant placeholder rulesets

**`EgoGraphEditorial.module.css`:**

- Remove `.bg`, `.halo`, `.frag`, `.person`, `.hopFar` placeholder
  rulesets. Lightning CSS exports descendant-only classes from the
  module (verified empirically via DOM inspection).

**Effort:** 5 minutes. Optional, purely tidying.

### 4.11 P2, focus card subtype tag fallback

**`Sidebar.tsx`:**

- When `focusSubtype` is undefined, render just the type ("WIKI") in the
  fc-tag, not "WIKI · WIKI".

**Effort:** 2 minutes.

### 4.12 P2, breadcrumb middle slot

**`TopBar.tsx`:**

- When `focusSubtype` is undefined, drop the middle slot entirely so the
  breadcrumb reads "Wiki / <focusTitle>" instead of "Wiki / Wikis / ...".

**Effort:** 5 minutes.

### 4.13 P3, summary copy generation

Reference shows "Robin currently holds <em>high confidence</em> that
revenue will land near $32m for Q4..." — domain-specific prose with
`<em>` highlights on key terms. We don't have a synthesizer for this.

Three options:

1. **Stay generated:** leave the count-driven sentence. Honest but flat.
2. **Static template variants:** rotate among 3-5 templates that pick
   the highest-degree neighbor names and italicize them. Improves visual
   without lying.
3. **Backend synthesis:** the focus wiki body text has structured
   sections; the API could return a 1-2 sentence summary derived from
   the wiki body or a precomputed "tagline" column.

Decision needed.

### 4.14 P3, provenance timestamps

`/api/graph` does not emit `created_at`/`updated_at` on nodes. Three options:

1. **Stay omitted.** Show id, type, hop, vault. Honest, flat.
2. **Show "n/a"** placeholders. Worse than omitted.
3. **Extend API** to emit `createdAt`, `updatedAt`, `lastReindexedAt` on
   nodes. Requires backend change and adds payload weight.

Decision needed.

### 4.15 P3, focus pulse / motion preference

Already covered in 4.2 via `@media (prefers-reduced-motion: no-preference)`.

### 4.16 P3, fragment subtype hint colors

Check whether `fragments` table has a `subtype` column with values
mapping to fact/idea/quote/observation. If yes, plumb through the API
and render. If no, parked.

**Effort:** depends on schema.

### 4.17 P3, ⌘K search wiring

Out of scope for the editorial port. Leaves a presentational button.

### 4.18 P3, Tab/Enter keyboard nav for nodes

Out of scope for the editorial port. Tab order works for the chrome
buttons.

### 4.19 P3, dense graph virtualization

When node count exceeds ~500, SVG render becomes a bottleneck. Out of
scope; document the threshold in PR notes.

### 4.20 P3, mobile responsive

Below 1024 the panel hides per 4.3. Below 600 the layout collapses;
out of scope, redirect to canvas view.

### 4.21 P3, real-time `UPDATED` corner

Reference shows "now · ⏵ live". Our copy is hardcoded. Wire to a
client-side timer or a server-side timestamp on the graph response.
Polish, not blocking.

### 4.22 P3, GraphCanvas decommission

Phase 5 of the original orchestration. The canvas /graph remains as
the legacy view for now.

### 4.23 P3, server-side ego endpoint

Phase 2 of the original orchestration. We keep client-side
`extractEgoSubgraph` until graph payloads grow past local-BFS limits.

---

## 5. Execution sequence

Three phases on top of the existing PR `feat/ego-graph-editorial`.
Each phase is an atomic commit, verified independently.

### Phase X1, subtype data flow

Files:
- `core/src/routes/graph.ts` (or equivalent)
- `core/src/<schema source>` (the wiki node response schema)
- `wiki/src/lib/generated/<regenerated client types>`
- `wiki/src/app/(graph)/graph/ego/[id]/EgoGraphPageClient.tsx`

Commit: `feat(graph): emit wiki subtype on graph nodes`

Body: explain that the editorial palette was unreachable until this
field crossed the wire; canvas view is unaffected because it never
read the field; field is optional so older clients keep working.

### Phase X2, focus + edges + proportions

Files:
- `wiki/src/components/ego-graph-editorial/EgoGraphEditorial.module.css`
- `wiki/src/components/ego-graph-editorial/lib/nodeShapes.tsx`
- `wiki/src/components/ego-graph-editorial/components/Stage.tsx`

Commit: `fix(ego-graph): focus dominance, edge contrast, stage proportions`

Body: tighten focus ring opacity and pulse animation, rebalance edge
strokes per kind, narrow sidebar, narrow detail, hide detail on small
viewports.

### Phase X3, polish

Files:
- `Stage.tsx` (fit-zoom button, drag-vs-click, wheel ref)
- `Tooltip.tsx` (edge clamping)
- `Sidebar.tsx` (focus card tag fallback)
- `TopBar.tsx` (breadcrumb fallback)
- `EgoGraphEditorial.module.css` (drop redundant placeholders, reduced-motion)

Commit: `polish(ego-graph): fit-zoom, drag-click, tooltip clamping, micro-fallbacks`

Body: enumerate the small visual and interaction fixes.

### Phase X4 (optional, decision-gated)

If user picks summary-copy or provenance extensions, those land here.

### Verification gate

After Phase X2 and Phase X3, screenshot at 1600x1000 against
`sclip.png` and confirm:

- Focus reads as the anchor.
- Wiki nodes show distinct subtype colors.
- Edge kinds visually differentiate.
- No text spaghetti at hop 2/3.
- Tooltip stays in viewport.

---

## 6. Risks and rollback

### 6.1 Subtype field type drift

If the server emits `subtype` and we forget to regenerate the client
types, the field is silently typed as `unknown`. Worst case: TypeScript
allows the property access via `as any` casts, runtime works, but later
edits lose the contract.

Mitigation: include the regenerated types file in the same commit that
adds the server field. CI type-check catches drift.

Rollback: revert the commit; field becomes optional and clients ignore
the omission.

### 6.2 Canvas view break

The canvas `/graph` page reads from the same endpoint. Adding an
optional `subtype` field does not break it. Verify by visiting `/graph`
after the change and confirming no console errors.

Rollback: same as 6.1.

### 6.3 Animation perf on weak devices

`@keyframes pulse` runs an infinite opacity animation. On low-end
devices this is fine for one ring. Mitigation: reduced-motion media
query.

### 6.4 Subtype palette blow-up if new subtype lands

If someone adds a wiki subtype the palette doesn't know about,
`SUBTYPE_COLOR[subtype]` returns undefined and we fall back to
`#1e2939`. Acceptable.

### 6.5 Stale wheel zoom closure

The current listener thrash is functionally fine but compound rapid
events can apply against stale state. Phase X3 fixes via ref.

### 6.6 Tooltip clamping breaks on resize

If user resizes window mid-hover, clamping recomputes on next mouse
move. Acceptable.

### 6.7 Detail panel hidden on narrow viewport

Below 1024 the panel disappears entirely. Users on small screens lose
the connection list. Acknowledged trade-off; canvas view is the
fallback at small sizes.

---

## 7. Decision points (need user input)

These cannot be resolved without your call:

1. **Provenance timestamps.** Stay omitted, show n/a, or extend API.
2. **Summary copy.** Stay generated from counts, add static template
   variants with `<em>` highlights, or extend API to emit a tagline.
3. **Mobile (< 1024).** Hide detail panel, hide both sidebar+detail, or
   redirect to /graph (canvas).
4. **Fragment subtype hint colors.** Worth wiring if `fragments.subtype`
   exists; check schema or skip.
5. **Subtype "Beliefs/Decisions/etc" plural form.** Right now we use
   naive English pluralization. Want a curated map (e.g. "principle"
   to "Principles", "voice" to "Voices") or keep naive?
6. **Keep or drop** the redundant CSS module placeholder rules
   (`.bg`, `.halo`, `.frag`, `.person`, `.hopFar`)? Keeping them
   is harmless; dropping is tidier.
7. **fit-zoom semantics.** Fit-to-current-filter (depth/type respected)
   or fit-to-all-nodes (ignore filters)?

---

## 8. Verification

### 8.1 Code verification (per phase)

- `pnpm -C wiki tsc --noEmit` exits 0.
- `pnpm -C wiki exec eslint src/components/ego-graph-editorial src/app/\(graph\)` exits 0.
- `pnpm -C core test` (if relevant tests) passes.

### 8.2 Visual verification

After each phase, screenshot `/graph/ego/<wiki id>` at 1600x1000 and
diff against `sclip.png`. Specific checks:

- Focus pulses, dominates center.
- Wiki nodes show distinct subtype colors (after Phase X1).
- Hop-1 labels visible, hop-2/3 hidden.
- Edge kinds differ in color and dash.
- Stage column reads dominant.
- Sidebar focus card tag is "<SUBTYPE> · WIKI".
- Detail panel pretitle dot color matches focus subtype.
- Conn-list dots pick up neighbor subtype colors.
- Zoom controls have 4 buttons.
- Tooltip stays in viewport at all hover positions.
- No console errors.

### 8.3 Functional verification

- Hover a node, neighbors light, non-neighbors dim.
- Click a node, detail panel updates.
- Esc, detail returns to focus.
- Toggle hop depth 1/2/3, ring count changes.
- Toggle type filter, nodes hide.
- Drag pan, click without movement clears selection.
- Wheel zoom in / out / reset.
- Fit-zoom centers and fits.
- Resize window from 1600 down to 1024, layout reflows.
- Sign out mid-session, AuthGuard redirects.

### 8.4 Cross-browser check (light)

- Latest Chromium: full support.
- Firefox: SVG paths and CSS modules verified by Next/lightning.
- Safari: STIX font fallback chain. Verify italic R brand mark renders.

---

## 9. Out of scope (parked)

These are deferred to follow-up phases. Listed so they don't accidentally
sneak in:

1. Backend `GET /graph/ego/:id` endpoint (Phase 2 of original
   orchestration). Client-side BFS via `extractEgoSubgraph` stays.
2. Tests + Storybook (Phase 4).
3. Decommission `GraphCanvas.tsx` (Phase 5).
4. Full keyboard navigation (Tab, Enter, arrow keys to traverse).
5. Screen reader landmarks beyond the chrome.
6. ⌘K command palette wiring.
7. Real-time UPDATED corner.
8. SVG virtualization for 1000+ nodes.
9. Mobile responsive < 1024 (beyond hiding panels).
10. Print stylesheet.
11. URL-driven selection (`?selected=<id>`).
12. Touch / pinch zoom.

---

## 10. Estimated total effort

- Phase X1 (subtype data flow): 30 min
- Phase X2 (focus + edges + proportions): 45 min
- Phase X3 (polish): 60 min
- Verification: 30 min

Total: ~3 hours. Subtype data flow is the highest leverage; if only one
phase ships, ship X1.

---

## 11. Where this lives

This plan: `.planning/phases/ego-graph-editorial/CLOSURE-PLAN.md`
Reference (extracted from sclip.png at runtime):
  - `.planning/phases/ego-graph-editorial/REFERENCE-EXTRACTED.css`
  - `.planning/phases/ego-graph-editorial/REFERENCE-EXTRACTED.html`
Original textual reference (out of date, retain for history):
  - `.planning/phases/ego-graph-editorial/REFERENCE.md`
PR: https://github.com/withrobinhq/robinwiki/pull/374
Branch: feat/ego-graph-editorial
Tracking issue: #372

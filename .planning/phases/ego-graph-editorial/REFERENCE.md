# Ego Graph Editorial — Design Reference

## Tokens

```css
:root {
  --paper:#f0eee9; --paper-2:#fafaf6; --paper-3:#e9e6dc;
  --ink:#1a1d22;   --ink-2:#3a3f48;   --ink-3:#676d76;
  --ink-4:#a2a9b1; --ink-5:#d8dbdf;
  --rule:#0e1116;  --rule-2:#cdc9bc;
  --blue:#3366cc;  --blue-soft:#e8eef9; --blue-ink:#1d3f87;
  --serif:"STIX Two Text","Iowan Old Style",Georgia,serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
  --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,sans-serif;
}
```

Wiki subtype palette:
- belief #3366cc, decision #c08a3e, goal #2f7a4f, project #c2562a,
  principle #1e2939, log #6b6960, collection #8a7a4f, skill #6b4f9e,
  agent #b54a6a, voice #2b7a7a
- Fragment fallback: `#7a8499`. Person stroke fallback: `#8a6d3a`.
- Fragment subtype hints (optional): fact #0284c7, idea #7a4fbf, quote #a06030, observation #4a8f8f.

## Layout

```ts
const W=1000, H=700, CX=W/2, CY=H/2;
const RING_R = [0, 150, 285, 410];

// FNV-1a deterministic hash
function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619; h >>>= 0; }
  return h;
}

// For each hop ring (1..3):
// 1. Sort nodes by (type weight, subtype) — wikis first, fragments, then people.
//    type weight: wiki=0, fragment=1, person=2.
// 2. baseAngle = (i / arr.length) * 2π
// 3. h = strHash(node.id)
// 4. angle  = baseAngle + ((h%41)/41 - 0.5) * (2π/arr.length) * 0.55
// 5. rJit   = ringR[hop] + ((h%23)/23 - 0.5) * (hop===3?28:hop===2?22:18)
// 6. x = CX + cos(angle)*rJit;  y = CY + sin(angle)*rJit
// Focus node sits at (CX, CY).
```

## Edges

Quadratic bezier bent toward graph center:

```ts
function curve(x1,y1,x2,y2,cx=CX,cy=CY) {
  const mx=(x1+x2)/2, my=(y1+y2)/2;
  const dx=mx-cx, dy=my-cy;
  const k = 0.25;
  const ccx = mx - dx*k, ccy = my - dy*k;
  return `M ${x1} ${y1} Q ${ccx} ${ccy} ${x2} ${y2}`;
}
```

Edge classes:
- `.edge` — base: stroke `--ink-4`, width .8, opacity .45
- `.edge.filing` — same, opacity .35
- `.edge.wikilink` — stroke `--blue`, opacity .5
- `.edge.mention` — stroke `#8a7a4f`, dasharray `3 3`, opacity .45
- `.edge.isDim` — opacity .08
- `.edge.isHot` — opacity .95, stroke-width 1.6

## Node shapes

**Focus** (only the focus id):
- Dashed outer ring at r=baseR+14 (var --blue, dasharray "3 5", animated pulse)
- Four cross marks (small lines at top/bottom/left/right, 6–22px from edge)
- Translucent halo circle at r=baseR+3, fill=color, opacity .12
- Solid filled circle at r=baseR (color)
- Inner stroked circle at r=baseR-4, fill=color, stroke=#fff, stroke-width 1.5
- Label below at y=baseR+6, serif, 14px, color --ink, weight 600

**Wiki** (non-focus):
- Outer circle r=baseR, fill=color, opacity=hopOpacity
- Inner circle r=baseR-3, fill=color (slightly stronger), 0.4 white stroke .8px
- Label at y=baseR+6, sans, 11px, color --ink-2, weight 500. Hide unless focus/hover/1-hop.

**Fragment**:
- Outer dashed halo r=baseR+3, stroke=color, dasharray "2 2", opacity .6 * hopOpacity
- Solid filled circle r=baseR, fill=color, stroke=color, stroke-width 1, opacity .8 * hopOpacity
- Label mono, 9px, color --ink-3, letter-spacing .04em. Hide unless focus/hover/1-hop.

**Person**:
- Background circle r=baseR, fill=`var(--paper-2)`, stroke=color, stroke-width 2, opacity hopOpacity
- Inner circle r=baseR-4, fill=color, opacity .15
- Label sans 11px.

Hop opacity tiers: `[1, 1, 0.78, 0.5]` indexed by hop (0=focus, 1, 2, 3).

## Sizes

Focus baseR ≈ 22–24. Hop 1 wikis 14–18, fragments 7–8, people 9–11. Hop 2: 11–13, 6–7, 8–9. Hop 3: 8–9, 6, 7–8. Pick from the node's own metadata (`node.size`) when available, else default by type+hop.

## Interactions

- Hover node: dim all edges except those touching it (`isDim`); raise touching edges to `isHot`. Dim non-neighbour nodes (opacity .18, hide labels). Show tooltip.
- Click node: set as `selected` (separate from hover). Detail panel reflects it. Esc clears (selected → focus).
- Click background: also clears selected back to focus.
- Wheel on stage: zoom .5 – 2.4. Step factor 1.08 / 0.92.
- Drag stage (not nodes): pan.
- Depth segmented: 1 / 2 / 3 hops. Filters out nodes with hop > depth.
- Type filter rows: toggle wiki / fragment / person. Off rows get `.isOff` (opacity .4).

## Sidebar sections, in order

1. Focus card — blue-soft background, blue-ink labels.
2. Hop depth control + help.
3. Node types + counts (live, recomputed from filtered nodes).
4. Wiki subtype legend (2-col grid, dot + name).
5. Edge legend (3 line samples: filing solid grey, wikilink solid blue, mention dashed tan).
6. Hop styling micro-legend.

## Detail panel sections

1. Header: pretitle (color dot + type + hop position) + serif title + italic serif subtitle + close button.
2. At a glance: 3 stat cards (fragments, wiki links, people).
3. Summary: serif paragraph, auto-synthesised stub copy with `<em>` highlights for key terms.
4. Direct connections: list of up to 9 conn rows (dot + serif title + mono subtype). Click navigates.
5. Provenance: mono key/value rows (id, created, last edit, last reindex, vault).

## Stage corner labels

Four absolute-positioned blocks at TL/TR/BL/BR with mono uppercase 10px tracking. Content suggestions:
- TL: `FIG. 01 · ego graph` / `v = <count> · e = <count>`
- TR: `VAULT · work` / `profile · operating`
- BL: `SCALE` / `≈ 220 px / hop`
- BR: `UPDATED` / `<rel time> · ⏵ live`

## Top bar

48px height, paper-2 bg, ink-5 bottom border. Left: brand mark (22px blue rounded square with serif italic "R") + "Robin" wordmark + breadcrumb (Wiki / Beliefs / focus title). Right: segmented View toggle (List / Wiki / Ego graph — only Ego graph active), Export button, Search button with `⌘ K` kbd hint.

## Animations

- Focus ring `animation: pulse 4s ease-in-out infinite` between opacity .55 ↔ .85.
- Nodes: `animation: fadeIn .4s ease both` on first paint.
- Edges and node bg use `transition: opacity .15s, stroke-width .15s`.

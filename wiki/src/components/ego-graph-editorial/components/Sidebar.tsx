"use client";

import type { Dispatch } from "react";
import type {
  EgoEdge,
  EgoGraphState,
  LaidOutNode,
  NodeType,
  WikiSubtype,
} from "../types";
import type { EgoGraphAction } from "../hooks/useEgoGraphState";
import {
  FRAGMENT_FALLBACK,
  PERSON_STROKE_FALLBACK,
  SUBTYPE_COLOR,
} from "../lib/colors";
import styles from "../EgoGraphEditorial.module.css";

interface SidebarProps {
  state: EgoGraphState;
  dispatch: Dispatch<EgoGraphAction>;
  /** Unfiltered laid-out nodes so counts reflect the full neighborhood. */
  nodes: LaidOutNode[];
  edges: EgoEdge[];
  focusNode: LaidOutNode;
}

const TYPE_ROWS: ReadonlyArray<{
  type: NodeType;
  label: string;
  color: string;
}> = [
  { type: "wiki", label: "Wiki", color: SUBTYPE_COLOR.belief },
  { type: "fragment", label: "Fragment", color: FRAGMENT_FALLBACK },
  { type: "person", label: "Person", color: PERSON_STROKE_FALLBACK },
];

const DEPTH_OPTIONS: ReadonlyArray<{ depth: 1 | 2 | 3; label: string }> = [
  { depth: 1, label: "1 hop" },
  { depth: 2, label: "2 hops" },
  { depth: 3, label: "3 hops" },
];

const HOP_OPACITIES: ReadonlyArray<{ opacity: number; label: string }> = [
  { opacity: 1, label: "Hop 1" },
  { opacity: 0.78, label: "Hop 2" },
  { opacity: 0.5, label: "Hop 3" },
];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Sidebar({
  state,
  dispatch,
  nodes,
  edges,
  focusNode,
}: SidebarProps) {
  // Counts of nodes per type, excluding the focus node itself.
  const typeCounts: Record<NodeType, number> = {
    wiki: 0,
    fragment: 0,
    person: 0,
  };
  for (const n of nodes) {
    if (n.id === focusNode.id) continue;
    typeCounts[n.type] += 1;
  }

  // Walk edges from the focus node to classify direct neighbors. The focus
  // card meta line wants per-type counts of 1-hop neighbors.
  const focusNeighborTypes: Record<NodeType, number> = {
    wiki: 0,
    fragment: 0,
    person: 0,
  };
  const seen = new Set<string>();
  const indexById = new Map<string, LaidOutNode>();
  for (const n of nodes) indexById.set(n.id, n);
  for (const e of edges) {
    let otherId: string | null = null;
    if (e.source === focusNode.id) otherId = e.target;
    else if (e.target === focusNode.id) otherId = e.source;
    if (!otherId || seen.has(otherId)) continue;
    seen.add(otherId);
    const other = indexById.get(otherId);
    if (!other) continue;
    focusNeighborTypes[other.type] += 1;
  }

  const focusSubtypeTag =
    (focusNode.subtype ?? focusNode.type ?? "wiki").toString().toUpperCase();

  return (
    <aside className={styles.sidebar}>
      <section className={styles.sidebarSection}>
        <div className={styles.focusCard}>
          <div className={styles.focusCardTag}>{focusSubtypeTag}</div>
          <div className={styles.focusCardTitle}>{focusNode.label}</div>
          <div className={styles.focusCardMeta}>
            {`${focusNeighborTypes.fragment} fragments · ${focusNeighborTypes.wiki} wiki links · ${focusNeighborTypes.person} people`}
          </div>
        </div>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Hop depth</h3>
        <div className={styles.depthRow} role="group" aria-label="Hop depth">
          {DEPTH_OPTIONS.map((opt) => {
            const active = state.depth === opt.depth;
            return (
              <button
                key={opt.depth}
                type="button"
                className={`${styles.depthBtn} ${
                  active ? styles.depthBtnActive : ""
                }`.trim()}
                aria-pressed={active}
                onClick={() => dispatch({ type: "SET_DEPTH", depth: opt.depth })}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className={styles.helpText}>
          {`Showing nodes within ${state.depth} hop${state.depth === 1 ? "" : "s"} of focus.`}
        </div>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Types</h3>
        {TYPE_ROWS.map((row) => {
          const on = state.activeTypes.has(row.type);
          return (
            <button
              key={row.type}
              type="button"
              className={`${styles.typeRow} ${on ? "" : styles.isOff}`.trim()}
              aria-pressed={on}
              onClick={() =>
                dispatch({ type: "TOGGLE_TYPE", nodeType: row.type })
              }
            >
              <span
                className={styles.swatch}
                style={{ background: row.color }}
                aria-hidden="true"
              />
              <span className={styles.typeRowName}>{row.label}</span>
              <span className={styles.typeRowCount}>
                {typeCounts[row.type]}
              </span>
            </button>
          );
        })}
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Wiki subtypes</h3>
        <div className={styles.subtypeGrid}>
          {(Object.entries(SUBTYPE_COLOR) as Array<[WikiSubtype, string]>).map(
            ([subtype, color]) => (
              <div key={subtype} className={styles.subtypeRow}>
                <span
                  className={styles.subtypeDot}
                  style={{ background: color }}
                  aria-hidden="true"
                />
                <span>{capitalise(subtype)}</span>
              </div>
            ),
          )}
        </div>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Edges</h3>
        <div className={styles.edgeLegendRow}>
          <svg width="16" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="16"
              y2="3"
              stroke="#a2a9b1"
              strokeWidth="1"
            />
          </svg>
          <span>Filing</span>
        </div>
        <div className={styles.edgeLegendRow}>
          <svg width="16" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="16"
              y2="3"
              stroke="#3366cc"
              strokeWidth="1"
            />
          </svg>
          <span>Wiki link</span>
        </div>
        <div className={styles.edgeLegendRow}>
          <svg width="16" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="16"
              y2="3"
              stroke="#8a7a4f"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          </svg>
          <span>Mention</span>
        </div>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Hop styling</h3>
        <div className={styles.hopLegend}>
          {HOP_OPACITIES.map((h) => (
            <div key={h.label} className={styles.hopLegendItem}>
              <span
                className={styles.hopDot}
                style={{ opacity: h.opacity }}
                aria-hidden="true"
              />
              <span>{h.label}</span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

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
  swatchClass?: string;
}> = [
  { type: "wiki", label: "Wiki", color: "var(--blue)" },
  { type: "fragment", label: "Fragment", color: "#7a8499", swatchClass: "frag" },
  { type: "person", label: "Person", color: "#8a6d3a", swatchClass: "person" },
];

const DEPTH_OPTIONS: ReadonlyArray<{ depth: 1 | 2 | 3; label: string }> = [
  { depth: 1, label: "1 hop" },
  { depth: 2, label: "2 hops" },
  { depth: 3, label: "3 hops" },
];

const SUBTYPE_LABEL: Record<WikiSubtype, string> = {
  belief: "Belief",
  decision: "Decision",
  goal: "Goal",
  project: "Project",
  principle: "Principle",
  log: "Log",
  collection: "Collection",
  skill: "Skill",
  agent: "Agent",
  voice: "Voice",
};

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
  const totalShown = typeCounts.wiki + typeCounts.fragment + typeCounts.person;
  const totalAll = nodes.length - 1;

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

  const focusSubtypeRaw = focusNode.subtype ?? focusNode.type ?? "wiki";
  const focusTypeUpper = focusNode.type.toUpperCase();
  const focusSubtypeUpper = focusSubtypeRaw.toString().toUpperCase();
  const focusTag = `${focusSubtypeUpper} · ${focusTypeUpper}`;

  return (
    <aside className={styles.sidebar}>
      {/* Focus card */}
      <section className={styles.sideSection}>
        <div className={styles.sideH}>
          <span>Focus node</span>
          <span className={styles.count}>§ 01</span>
        </div>
        <div className={styles.focusCard}>
          <div className={styles.fcTag}>{focusTag}</div>
          <div className={styles.fcTitle}>{focusNode.label}</div>
          <div className={styles.fcMeta}>
            <span><b>{focusNeighborTypes.fragment}</b> fragments</span>
            <span><b>{focusNeighborTypes.wiki}</b> wiki links</span>
            <span><b>{focusNeighborTypes.person}</b> people</span>
          </div>
        </div>
      </section>

      {/* Hop depth */}
      <section className={styles.sideSection}>
        <div className={styles.sideH}>
          <span>Hop depth</span>
          <span className={styles.count}>{`${state.depth} HOPS`}</span>
        </div>
        <div className={styles.depth} role="group" aria-label="Hop depth">
          {DEPTH_OPTIONS.map((opt) => {
            const active = state.depth === opt.depth;
            return (
              <button
                key={opt.depth}
                type="button"
                className={active ? styles.isActive : ""}
                aria-pressed={active}
                onClick={() => dispatch({ type: "SET_DEPTH", depth: opt.depth })}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className={styles.depthHelp}>
          How far Robin will trace knowledge from the focus.
          Hop 1 is direct neighbours; hop 3 is everything Robin still considers
          relevant context.
        </div>
      </section>

      {/* Type filters */}
      <section className={styles.sideSection}>
        <div className={styles.sideH}>
          <span>Node types</span>
          <span className={styles.count}>{`${totalShown} · ${totalAll}`}</span>
        </div>
        <div className={styles.types}>
          {TYPE_ROWS.map((row) => {
            const on = state.activeTypes.has(row.type);
            const swatchClass = [
              styles.swatch,
              row.swatchClass === "frag" ? styles.frag : "",
              row.swatchClass === "person" ? styles.person : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={row.type}
                type="button"
                className={`${styles.typeRow} ${on ? "" : styles.isOff}`.trim()}
                style={{ color: row.color }}
                aria-pressed={on}
                onClick={() =>
                  dispatch({ type: "TOGGLE_TYPE", nodeType: row.type })
                }
              >
                <span className={swatchClass} aria-hidden="true" />
                <span className={styles.name}>{row.label}</span>
                <span className={styles.num}>{typeCounts[row.type]}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Wiki subtypes */}
      <section className={styles.sideSection}>
        <div className={styles.sideH}>
          <span>Wiki subtypes</span>
          <span className={styles.count}>10</span>
        </div>
        <div className={styles.subGrid}>
          {(Object.entries(SUBTYPE_COLOR) as Array<[WikiSubtype, string]>).map(
            ([subtype, color]) => (
              <div key={subtype} className={styles.subRow}>
                <span
                  className={styles.dot}
                  style={{ background: color }}
                  aria-hidden="true"
                />
                <span>{SUBTYPE_LABEL[subtype] ?? capitalise(subtype)}</span>
              </div>
            ),
          )}
        </div>
      </section>

      {/* Edge legend */}
      <section className={styles.sideSection}>
        <div className={styles.sideH}>
          <span>Edges</span>
          <span className={styles.count}>3</span>
        </div>
        <div className={styles.types}>
          <div
            className={styles.typeRow}
            style={{ color: "var(--ink-3)", cursor: "default" }}
          >
            <span
              style={{
                display: "inline-block",
                width: 18,
                height: 0,
                borderTop: "1px solid currentColor",
              }}
              aria-hidden="true"
            />
            <span className={styles.name}>Filing</span>
            <span className={styles.num}>structural</span>
          </div>
          <div
            className={styles.typeRow}
            style={{ color: "var(--blue)", cursor: "default" }}
          >
            <span
              style={{
                display: "inline-block",
                width: 18,
                height: 0,
                borderTop: "1.5px solid currentColor",
              }}
              aria-hidden="true"
            />
            <span className={styles.name}>Wikilink</span>
            <span className={styles.num}>authored</span>
          </div>
          <div
            className={styles.typeRow}
            style={{ color: PERSON_STROKE_FALLBACK, cursor: "default" }}
          >
            <span
              style={{
                display: "inline-block",
                width: 18,
                height: 0,
                borderTop: "1.5px dashed currentColor",
              }}
              aria-hidden="true"
            />
            <span className={styles.name}>Mention</span>
            <span className={styles.num}>inferred</span>
          </div>
        </div>
        {/* FRAGMENT_FALLBACK reserved for future fragment-edge swatch use */}
        <div hidden aria-hidden style={{ color: FRAGMENT_FALLBACK }} />
      </section>

      {/* Hop styling legend */}
      <section className={styles.sideSectionLast}>
        <div className={styles.sideH}>
          <span>Hop styling</span>
        </div>
        <div className={styles.hops} style={{ marginBottom: 6 }}>
          <span className={styles.h} style={{ color: "var(--blue)" }}>
            <span className={styles.b} style={{ background: "var(--blue)" }} />
          </span>
          <span>Focus</span>
        </div>
        <div className={styles.hops} style={{ marginBottom: 6 }}>
          <span className={styles.h}>
            <span className={styles.b} style={{ borderWidth: 2 }} />
          </span>
          <span>1-hop · direct</span>
        </div>
        <div className={styles.hops} style={{ marginBottom: 6, opacity: 0.7 }}>
          <span className={styles.h}>
            <span className={styles.b} />
          </span>
          <span>2-hop · related</span>
        </div>
        <div className={styles.hops} style={{ opacity: 0.45 }}>
          <span className={styles.h}>
            <span className={styles.b} />
          </span>
          <span>3-hop · adjacent</span>
        </div>
      </section>
    </aside>
  );
}

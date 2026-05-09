"use client";

import { X } from "lucide-react";
import type { LaidOutNode, NodeType } from "../types";
import { nodeColor } from "../lib/colors";
import styles from "../EgoGraphEditorial.module.css";

interface DetailPanelProps {
  node: LaidOutNode | null;
  focusId: string;
  /** Direct neighbors of `node`, used for the connection list and stat counts. */
  connections: LaidOutNode[];
  /** Clears selection back to the focus. Wired to dispatch CLEAR_SELECT. */
  onClose: () => void;
  /** Re-targets selection to the clicked connection. Wired to dispatch SELECT. */
  onNavigate: (id: string) => void;
}

const MAX_CONNECTIONS = 9;

function shortId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}...`;
}

function typeLabel(t: NodeType): string {
  return t.toUpperCase();
}

export function DetailPanel({
  node,
  focusId,
  connections,
  onClose,
  onNavigate,
}: DetailPanelProps) {
  if (!node) {
    return (
      <aside className={styles.detail}>
        <div className={styles.detailEmpty}>Select a node to inspect</div>
      </aside>
    );
  }

  const color = nodeColor(node);

  // Per-type counts derived from the immediate neighbors.
  const counts: Record<NodeType, number> = { wiki: 0, fragment: 0, person: 0 };
  for (const c of connections) counts[c.type] += 1;

  const firstNeighbor = connections[0]?.label;
  const secondNeighbor = connections[1]?.label;

  const isFocus = node.id === focusId;
  const hopText = isFocus ? "FOCUS" : `HOP ${node.hop}`;
  const pretitle = `${typeLabel(node.type)} · ${hopText}`;

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <div className={styles.detailPretitle}>
          <span
            className={styles.detailDot}
            style={{ background: color }}
            aria-hidden="true"
          />
          <span>{pretitle}</span>
        </div>
        <h2 className={styles.detailTitle}>{node.label}</h2>
        <div className={styles.detailSubtitle}>Captured recently</div>
        <button
          type="button"
          className={styles.detailClose}
          onClick={onClose}
          aria-label="Clear selection"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>At a glance</h3>
        <div className={styles.statRow}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{counts.fragment}</div>
            <div className={styles.statLabel}>Fragments</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{counts.wiki}</div>
            <div className={styles.statLabel}>Wiki links</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{counts.person}</div>
            <div className={styles.statLabel}>People</div>
          </div>
        </div>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Summary</h3>
        <p className={styles.summary}>
          {`${node.label} sits ${node.hop} hop${node.hop === 1 ? "" : "s"} from the focus. It currently has ${connections.length} direct connection${connections.length === 1 ? "" : "s"}, including `}
          <em>{firstNeighbor ?? "no neighbors yet"}</em>
          {firstNeighbor ? " and " : ""}
          {firstNeighbor ? <em>{secondNeighbor ?? "..."}</em> : null}
          .
        </p>
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Direct connections</h3>
        {connections.length === 0 ? (
          <div className={styles.helpText}>No direct connections.</div>
        ) : (
          connections.slice(0, MAX_CONNECTIONS).map((c) => {
            const cColor = nodeColor(c);
            const sub = c.subtype ? c.subtype.toString() : c.type;
            return (
              <button
                key={c.id}
                type="button"
                className={styles.connRow}
                onClick={() => onNavigate(c.id)}
              >
                <span
                  className={styles.swatch}
                  style={{ background: cColor }}
                  aria-hidden="true"
                />
                <span className={styles.connRowTitle}>{c.label}</span>
                <span className={styles.connRowMeta}>{sub.toUpperCase()}</span>
              </button>
            );
          })
        )}
      </section>

      <section className={styles.sidebarSection}>
        <h3 className={styles.sectionHeading}>Provenance</h3>
        <div className={styles.provRow}>
          <span className={styles.provKey}>id</span>
          <span className={styles.provVal}>{shortId(node.id)}</span>
        </div>
        <div className={styles.provRow}>
          <span className={styles.provKey}>created</span>
          <span className={styles.provVal}>n/a</span>
        </div>
        <div className={styles.provRow}>
          <span className={styles.provKey}>last edit</span>
          <span className={styles.provVal}>n/a</span>
        </div>
        <div className={styles.provRow}>
          <span className={styles.provKey}>last reindex</span>
          <span className={styles.provVal}>n/a</span>
        </div>
        <div className={styles.provRow}>
          <span className={styles.provKey}>vault</span>
          <span className={styles.provVal}>work</span>
        </div>
      </section>
    </aside>
  );
}

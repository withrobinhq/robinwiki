"use client";

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
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}...${id.slice(-8)}`;
}

function typeLabel(t: NodeType): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function subShort(c: LaidOutNode): string {
  if (c.subtype) return c.subtype.toString();
  return c.type;
}

export function DetailPanel({
  node,
  focusId,
  connections,
  onClose,
  onNavigate,
}: DetailPanelProps) {
  // Pretitle / title fall back to focus-style copy when no node is
  // selected; this matches the reference, which always renders the
  // detail pane with focus content as the resting state.
  const isFocus = !node || node.id === focusId;
  const display = node;

  if (!display) {
    return (
      <aside className={styles.detail}>
        <div className={styles.detailHead}>
          <div className={styles.detailHeadInner}>
            <div className={styles.detailPretitle}>
              <span
                className={styles.dot}
                style={{ background: "var(--ink-4)" }}
                aria-hidden="true"
              />
              <span>—</span>
              <span className={styles.hop}>no selection</span>
            </div>
            <h1 className={styles.detailTitle}>Select a node</h1>
            <div className={styles.detailSubtitle}>
              Click any node in the graph to inspect its connections, fragments,
              and provenance.
            </div>
          </div>
        </div>
      </aside>
    );
  }

  const color = nodeColor(display);

  // Per-type counts derived from the immediate neighbors.
  const counts: Record<NodeType, number> = { wiki: 0, fragment: 0, person: 0 };
  for (const c of connections) counts[c.type] += 1;

  const subtypeUpper = (display.subtype ?? "").toString().toUpperCase();
  const typeUpper = display.type.toUpperCase();
  const pretitle = subtypeUpper
    ? `${subtypeUpper} · ${typeUpper}`
    : typeUpper;
  const hopText = isFocus ? "HOP 0 · FOCUS" : `HOP ${display.hop}`;

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <div className={styles.detailHeadInner}>
          <div className={styles.detailPretitle}>
            <span
              className={styles.dot}
              style={{ background: color }}
              aria-hidden="true"
            />
            <span>{pretitle}</span>
            <span className={styles.hop}>{hopText}</span>
          </div>
          <h1 className={styles.detailTitle}>{display.label}</h1>
          <div className={styles.detailSubtitle}>
            {isFocus
              ? `A live ${typeLabel(display.type)} that Robin keeps current as new fragments arrive.`
              : `${typeLabel(display.type)} captured ${display.hop} hop${display.hop === 1 ? "" : "s"} from focus.`}
          </div>
        </div>
        <button
          type="button"
          className={styles.detailClose}
          onClick={onClose}
          title="Clear selection"
        >
          esc
        </button>
      </div>

      <div className={styles.detailSection}>
        <h4>At a glance</h4>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statN}>{counts.fragment}</div>
            <div className={styles.statL}>fragments</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statN}>{counts.wiki}</div>
            <div className={styles.statL}>wiki links</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statN}>{counts.person}</div>
            <div className={styles.statL}>people</div>
          </div>
        </div>
      </div>

      <div className={styles.detailSection}>
        <h4>
          Summary <span className={styles.summaryAux}>· auto-synthesised</span>
        </h4>
        <p>
          Robin tracks <em>{connections.length} direct connection{connections.length === 1 ? "" : "s"}</em> from {display.label}. The neighborhood spans
          {" "}<em>{counts.wiki} wiki entr{counts.wiki === 1 ? "y" : "ies"}</em>,
          {" "}<em>{counts.fragment} fragment{counts.fragment === 1 ? "" : "s"}</em>, and
          {" "}<em>{counts.person} person link{counts.person === 1 ? "" : "s"}</em>.
        </p>
      </div>

      <div className={styles.detailSection}>
        <h4>
          Direct connections{" "}
          <span className={styles.summaryAux}>· {connections.length}</span>
        </h4>
        {connections.length === 0 ? (
          <div className={styles.connList}>
            <div
              className={styles.conn}
              style={{ color: "var(--ink-3)", cursor: "default" }}
            >
              <span className={styles.connT} style={{ color: "var(--ink-3)" }}>
                No direct connections
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.connList}>
            {connections.slice(0, MAX_CONNECTIONS).map((c) => {
              const cColor = nodeColor(c);
              const dotClass = [
                styles.dot,
                c.type === "fragment" ? styles.fragDot : "",
                c.type === "person" ? styles.personDot : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  type="button"
                  key={c.id}
                  className={styles.conn}
                  style={{ color: cColor }}
                  onClick={() => onNavigate(c.id)}
                >
                  <span
                    className={dotClass}
                    style={{ background: cColor }}
                    aria-hidden="true"
                  />
                  <span className={styles.connT} style={{ color: "var(--ink)" }}>
                    {c.label}
                  </span>
                  <span className={styles.connSub}>{subShort(c)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.detailSectionLast}>
        <h4>Provenance</h4>
        <p className={styles.provText}>
          <span className={styles.provKey}>id</span>
          <span className={styles.provVal}>&nbsp;&nbsp;{shortId(display.id)}</span>
          <br />
          <span className={styles.provKey}>type</span>
          <span className={styles.provVal}>&nbsp;&nbsp;{display.type}{display.subtype ? ` · ${display.subtype}` : ""}</span>
          <br />
          <span className={styles.provKey}>hop</span>
          <span className={styles.provVal}>&nbsp;&nbsp;{display.hop}</span>
          <br />
          <span className={styles.provKey}>vault</span>
          <span className={styles.provVal}>&nbsp;&nbsp;work</span>
        </p>
      </div>
    </aside>
  );
}

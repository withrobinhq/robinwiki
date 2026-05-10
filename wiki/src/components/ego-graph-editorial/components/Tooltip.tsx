"use client";

import type { LaidOutNode } from "../types";
import { nodeColor } from "../lib/colors";
import styles from "../EgoGraphEditorial.module.css";

interface TooltipProps {
  node: LaidOutNode | null;
  /** Stage-relative pixel coords. Tooltip centers itself horizontally. */
  screenX: number;
  screenY: number;
  connectionCount: number;
}

export function Tooltip({
  node,
  screenX,
  screenY,
  connectionCount,
}: TooltipProps) {
  if (!node) return null;

  const color = nodeColor(node);
  const hopText = node.hop === 0 ? "FOCUS" : `HOP ${node.hop}`;
  const typeText = node.subtype
    ? `${node.subtype.toString().toUpperCase()} · ${node.type.toUpperCase()}`
    : node.type.toUpperCase();

  return (
    <div
      className={`${styles.tooltip} ${styles.isOn}`}
      style={{
        left: screenX,
        top: screenY,
        transform: "translate(-50%, -110%)",
      }}
      role="tooltip"
    >
      <div className={styles.tooltipT}>
        <span
          className={styles.dot}
          style={{ background: color }}
          aria-hidden="true"
        />
        <span>{typeText}</span>
        <span style={{ marginLeft: "auto" }}>{hopText}</span>
      </div>
      <div className={styles.tooltipTitle}>{node.label}</div>
      <div className={styles.tooltipMeta}>
        <span>{`${connectionCount} conn.`}</span>
        <span>live</span>
      </div>
    </div>
  );
}

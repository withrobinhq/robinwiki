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

  // Keep the tooltip inside the viewport so a hover near the right or
  // bottom edge doesn't push the title off-screen. Tooltip lives inside
  // a 'use client' tree so window is safe to read.
  const clampedX = Math.max(80, Math.min(window.innerWidth - 80, screenX));
  const clampedY = Math.max(60, Math.min(window.innerHeight - 40, screenY));

  return (
    <div
      className={`${styles.tooltip} ${styles.isOn}`}
      style={{
        left: clampedX,
        top: clampedY,
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

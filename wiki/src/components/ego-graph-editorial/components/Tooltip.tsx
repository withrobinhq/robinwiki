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

  return (
    <div
      className={`${styles.tooltip} ${styles.tooltipIsOn}`}
      style={{
        left: screenX,
        top: screenY,
        transform: "translate(-50%, -110%)",
      }}
      role="tooltip"
    >
      <div className={styles.tooltipPretitle}>
        <span
          className={styles.tooltipDot}
          style={{ background: color }}
          aria-hidden="true"
        />
        <span>{`${node.type.toUpperCase()} · ${hopText}`}</span>
      </div>
      <div className={styles.tooltipTitle}>{node.label}</div>
      <div className={styles.tooltipMeta}>
        {`${connectionCount} connection${connectionCount === 1 ? "" : "s"} · live`}
      </div>
    </div>
  );
}

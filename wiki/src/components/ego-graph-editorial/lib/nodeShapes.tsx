import type { JSX } from "react";
import type { LaidOutNode, NodeType } from "../types";
import styles from "../EgoGraphEditorial.module.css";

/**
 * Pure JSX renderers for each node archetype. Each function returns
 * the inner contents of a `<g>` translated to the node's position;
 * the caller is responsible for keying and wrapping the group.
 *
 * The reference CSS uses compound selectors `.node circle.bg` and
 * `.node circle.halo` to drive transitions, hover halos, and focus
 * rings. To match, the bg circle gets `styles.bg` and the halo gets
 * `styles.halo` so both classes resolve to the same hashed names the
 * `.node` rules expect.
 */

// Default radius by (type, hop). Index 0 is the focus radius and is
// only referenced via renderFocus; the others map to ring 1, 2, 3.
const SIZE_DEFAULT: Record<NodeType, readonly number[]> = {
  wiki: [22, 16, 12, 9],
  fragment: [22, 8, 7, 6],
  person: [22, 10, 9, 8],
};

function baseR(n: LaidOutNode): number {
  if (typeof n.size === "number" && n.size > 0) return n.size;
  if (n.hop === 0) return 23;
  const row = SIZE_DEFAULT[n.type];
  return row[n.hop] ?? 10;
}

export function renderFocus(n: LaidOutNode, color: string): JSX.Element {
  const r = baseR(n);
  return (
    <g transform={`translate(${n.x} ${n.y})`}>
      <circle
        className={styles.focusRing}
        r={r + 14}
      />
      <g className={styles.focusCross}>
        <line x1={0} y1={-(r + 22)} x2={0} y2={-(r + 6)} />
        <line x1={0} y1={r + 6} x2={0} y2={r + 22} />
        <line x1={-(r + 22)} y1={0} x2={-(r + 6)} y2={0} />
        <line x1={r + 6} y1={0} x2={r + 22} y2={0} />
      </g>
      <circle r={r + 3} fill={color} opacity={0.12} />
      <circle className={styles.bg} r={r} fill={color} />
      <circle r={r - 4} fill={color} stroke="#ffffff" strokeWidth={1.5} />
      <circle className={styles.halo} r={r + 8} />
      <text y={r + 18}>{n.label}</text>
    </g>
  );
}

export function renderWiki(
  n: LaidOutNode,
  color: string,
  hopOpacity: number,
): JSX.Element {
  const r = baseR(n);
  return (
    <g transform={`translate(${n.x} ${n.y})`} opacity={hopOpacity}>
      <circle className={styles.bg} r={r} fill={color} />
      <circle
        r={Math.max(1, r - 3)}
        fill={color}
        stroke="rgba(255,255,255,0.4)"
        strokeWidth={0.8}
      />
      <circle className={styles.halo} r={r + 8} />
      <text y={r + 14}>{n.label}</text>
    </g>
  );
}

export function renderFragment(
  n: LaidOutNode,
  color: string,
  hopOpacity: number,
): JSX.Element {
  const r = baseR(n);
  return (
    <g transform={`translate(${n.x} ${n.y})`}>
      <circle
        className={styles.bg}
        r={r}
        fill={color}
        stroke={color}
        strokeWidth={1}
        opacity={0.8 * hopOpacity}
      />
      <circle
        r={r + 3}
        fill="none"
        stroke={color}
        strokeDasharray="2 2"
        opacity={0.6 * hopOpacity}
      />
      <circle className={styles.halo} r={r + 8} />
      <text y={r + 12}>{n.label}</text>
    </g>
  );
}

export function renderPerson(
  n: LaidOutNode,
  color: string,
  hopOpacity: number,
): JSX.Element {
  const r = baseR(n);
  return (
    <g transform={`translate(${n.x} ${n.y})`} opacity={hopOpacity}>
      <circle
        className={styles.bg}
        r={r}
        fill="var(--paper-2)"
        stroke={color}
        strokeWidth={2}
      />
      <circle r={Math.max(1, r - 4)} fill={color} opacity={0.15} />
      <circle className={styles.halo} r={r + 8} />
      <text y={r + 14}>{n.label}</text>
    </g>
  );
}

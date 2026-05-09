import type { EgoNode, LaidOutNode, NodeType } from "../types";
import { strHash } from "./hash";

export const W = 1000;
export const H = 700;
export const CX = 500;
export const CY = 350;
export const RING_R = [0, 150, 285, 410];

const TYPE_WEIGHT: Record<NodeType, number> = {
  wiki: 0,
  fragment: 1,
  person: 2,
};

/**
 * Project ego-graph nodes onto concentric rings.
 *
 * Hop 0 sits at the geometric center. Hops 1 through 3 spread evenly
 * around their ring, sorted by (type weight, subtype) so wikis come
 * first, fragments next, people last. A deterministic FNV jitter
 * nudges each node off its ideal slot so the rings don't read as a
 * rigid clock face. Nodes with `hopOf` greater than 3 are dropped.
 */
export function layoutConcentric(
  focusId: string,
  nodes: EgoNode[],
  hopOf: Map<string, number>
): LaidOutNode[] {
  const buckets = new Map<number, EgoNode[]>();
  for (const node of nodes) {
    const hop = hopOf.get(node.id);
    if (hop === undefined || hop > 3) continue;
    if (!buckets.has(hop)) buckets.set(hop, []);
    buckets.get(hop)!.push(node);
  }

  const out: LaidOutNode[] = [];

  const focus = nodes.find((n) => n.id === focusId);
  if (focus && hopOf.get(focusId) === 0) {
    out.push({ ...focus, x: CX, y: CY, hop: 0, angle: 0 });
  }

  for (let hop = 1; hop <= 3; hop++) {
    const ring = buckets.get(hop);
    if (!ring || ring.length === 0) continue;

    const sorted = [...ring].sort((a, b) => {
      const wa = TYPE_WEIGHT[a.type];
      const wb = TYPE_WEIGHT[b.type];
      if (wa !== wb) return wa - wb;
      const sa = a.subtype ?? "";
      const sb = b.subtype ?? "";
      return sa.localeCompare(sb);
    });

    const radial = hop === 3 ? 28 : hop === 2 ? 22 : 18;

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      const baseAngle = (i / sorted.length) * 2 * Math.PI;
      const h = strHash(node.id);
      const angle =
        baseAngle +
        ((h % 41) / 41 - 0.5) * ((2 * Math.PI) / sorted.length) * 0.55;
      const rJit = RING_R[hop] + ((h % 23) / 23 - 0.5) * radial;
      const x = CX + Math.cos(angle) * rJit;
      const y = CY + Math.sin(angle) * rJit;
      out.push({ ...node, x, y, hop, angle });
    }
  }

  return out;
}

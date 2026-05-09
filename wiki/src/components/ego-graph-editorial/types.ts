/**
 * Shared types for the editorial ego graph view.
 *
 * `EgoNode` and `EgoEdge` are the wire shapes the rest of the
 * component tree consumes. They mirror the upstream
 * `extractEgoSubgraph` payload from `@robin/graph`, with optional
 * `meta` to carry through any extra fields the caller has on hand.
 */

export type NodeType = "wiki" | "fragment" | "person";

export type WikiSubtype =
  | "belief"
  | "decision"
  | "goal"
  | "project"
  | "principle"
  | "log"
  | "collection"
  | "skill"
  | "agent"
  | "voice";

export type EdgeKind = "filing" | "wikilink" | "mention";

export interface EgoNode {
  id: string;
  type: NodeType;
  label: string;
  subtype?: WikiSubtype | string;
  size?: number;
  meta?: Record<string, unknown>;
}

export interface EgoEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface LaidOutNode extends EgoNode {
  x: number;
  y: number;
  hop: number;
  angle: number;
}

export interface EgoGraphState {
  hover: string | null;
  selected: string;
  depth: 1 | 2 | 3;
  activeTypes: Set<NodeType>;
  zoom: number;
  pan: { x: number; y: number };
}

import type { EgoNode, WikiSubtype } from "../types";

/**
 * Wiki subtype palette. Hex values are the canonical editorial
 * palette from REFERENCE.md, used both for node fills and the
 * sidebar legend dot row.
 */
export const SUBTYPE_COLOR: Record<WikiSubtype, string> = {
  belief: "#3366cc",
  decision: "#c08a3e",
  goal: "#2f7a4f",
  project: "#c2562a",
  principle: "#1e2939",
  log: "#6b6960",
  collection: "#8a7a4f",
  skill: "#6b4f9e",
  agent: "#b54a6a",
  voice: "#2b7a7a",
};

/**
 * Optional fragment subtype hints. Most fragments fall back to the
 * neutral grey, but the upstream classifier sometimes tags them with
 * a coarse role (fact, idea, quote, observation) we can colour for.
 */
const FRAGMENT_SUBTYPE_COLOR: Record<string, string> = {
  fact: "#0284c7",
  idea: "#7a4fbf",
  quote: "#a06030",
  observation: "#4a8f8f",
};

export const FRAGMENT_FALLBACK = "#7a8499";
export const PERSON_STROKE_FALLBACK = "#8a6d3a";

const WIKI_FALLBACK = "#1e2939";

/**
 * Resolve the display color for a node. Wikis prefer their subtype
 * palette entry, fragments prefer their optional subtype hint, and
 * person nodes always render the warm tan stroke colour.
 */
export function nodeColor(n: EgoNode): string {
  if (n.type === "wiki") {
    if (n.subtype && n.subtype in SUBTYPE_COLOR) {
      return SUBTYPE_COLOR[n.subtype as WikiSubtype];
    }
    return WIKI_FALLBACK;
  }
  if (n.type === "fragment") {
    if (n.subtype && n.subtype in FRAGMENT_SUBTYPE_COLOR) {
      return FRAGMENT_SUBTYPE_COLOR[n.subtype];
    }
    return FRAGMENT_FALLBACK;
  }
  return PERSON_STROKE_FALLBACK;
}

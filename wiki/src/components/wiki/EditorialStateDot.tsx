"use client";

import type { EditorialStateSchema } from "@/lib/generated/types.gen";

type EditorialState = EditorialStateSchema;

const STATE_COLORS: Record<EditorialState, string> = {
  empty: "var(--wiki-editorial-empty, #9ca3af)",
  learning: "var(--wiki-editorial-learning, #f59e0b)",
  dreaming: "var(--wiki-editorial-dreaming, #3b82f6)",
  filed: "var(--wiki-editorial-filed, #22c55e)",
};

/**
 * Derive editorial state client-side when the server-computed field is
 * missing (e.g. stale SDK). Mirrors the backend editorialStateOf().
 */
function deriveEditorialState(wiki: {
  state?: string;
  dirtySince?: string | null;
  lastRebuiltAt?: string | null;
}): EditorialState {
  if (!wiki.state || wiki.state === "PENDING") return "empty";
  if (wiki.state === "DIRTY" || wiki.dirtySince) return "learning";
  if (wiki.state === "LINKING") return "dreaming";
  return "filed";
}

export type EditorialStateDotProps = {
  /** Server-computed editorial state. Takes priority when present. */
  editorialState?: EditorialState;
  /** Fallback fields for client-side derivation when editorialState is absent. */
  state?: string;
  dirtySince?: string | null;
  lastRebuiltAt?: string | null;
  /** Dot diameter in pixels. Defaults to 8. */
  size?: number;
};

export function EditorialStateDot({
  editorialState,
  state,
  dirtySince,
  lastRebuiltAt,
  size = 8,
}: EditorialStateDotProps) {
  const resolved =
    editorialState ?? deriveEditorialState({ state, dirtySince, lastRebuiltAt });
  const color = STATE_COLORS[resolved];

  return (
    <span
      aria-label={`Editorial state: ${resolved}`}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

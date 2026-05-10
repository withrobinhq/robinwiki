"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { T, FONT } from "@/lib/typography";
import { useToggleBouncerMode } from "@/hooks/useToggleBouncerMode";

interface BouncerModeToggleProps {
  wikiId: string;
  bouncerMode: "auto" | "review";
}

/**
 * Toggle between auto-accept and review mode for fragment attachments.
 * Optimistic UI: flips the switch immediately and reverts on error.
 */
export function BouncerModeToggle({
  wikiId,
  bouncerMode,
}: BouncerModeToggleProps) {
  const toggle = useToggleBouncerMode();
  const [optimistic, setOptimistic] = useState<"auto" | "review" | null>(null);

  const effective = optimistic ?? bouncerMode;
  const isAuto = effective === "auto";

  const handleToggle = (checked: boolean) => {
    const next = checked ? "auto" : "review";
    setOptimistic(next);
    toggle.mutate(
      { id: wikiId, mode: next },
      {
        onSuccess: () => setOptimistic(null),
        onError: () => setOptimistic(null),
      },
    );
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <label
        style={{
          ...T.micro,
          fontFamily: FONT.SANS,
          color: "var(--wiki-article-text)",
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        Auto-accept fragments
      </label>
      <Switch
        checked={isAuto}
        onCheckedChange={handleToggle}
        disabled={toggle.isPending}
        size="sm"
        aria-label="Toggle auto-accept fragments"
      />
    </div>
  );
}

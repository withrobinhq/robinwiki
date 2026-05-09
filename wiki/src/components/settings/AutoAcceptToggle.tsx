"use client";

import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { T } from "@/lib/typography";
import { useAutoAcceptPersons } from "@/hooks/usePendingPersons";

// Stream U: wraps the auto-accept-persons setting in a small switch
// row. When enabled, newly extracted persons land directly with
// status='verified'; when disabled, they land as 'pending' and surface
// in this panel for manual triage.

export function AutoAcceptToggle() {
  const { get, set } = useAutoAcceptPersons();
  const checked = get.data?.autoAcceptPersons ?? false;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--card)",
        marginBottom: 16,
      }}
    >
      <div>
        <p style={{ ...T.body, fontWeight: 500, margin: 0 }}>
          Auto-accept new persons
        </p>
        <p
          style={{
            ...T.micro,
            color: "var(--heading-secondary)",
            margin: 0,
            marginTop: 2,
          }}
        >
          When on, the extractor lands new persons as verified. When off,
          they land as pending and appear below for review.
        </p>
      </div>
      {get.isLoading ? (
        <Spinner className="size-4" />
      ) : (
        <Switch
          checked={checked}
          onCheckedChange={(next: boolean) => set.mutate(next)}
          disabled={set.isPending}
          aria-label="Toggle auto-accept-persons"
        />
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { EditorialStateDot } from "@/components/wiki/EditorialStateDot";
import type { ThreadListResponseSchema } from "@/lib/generated/types.gen";
import { useToggleAutoRegen } from "@/hooks/useToggleAutoRegen";
import { useRegenerateWiki } from "@/hooks/useRegenerateWiki";

// The generator emits the wiki list shape under the legacy "thread" alias
// (Thread* mirrors the v0 thread tag in openapi.json). The single wiki
// entry type matches what GET /wikis returns; aliasing here so call
// sites read naturally.
type WikiListEntry = ThreadListResponseSchema["wikis"][number];

// Column track sizing shared by WikiRow and WikiRowHeader so a header
// renders directly above a body row without drift.
// Tracks: Wiki | Autoregen | Last regen | Frags | State | Regen | Backfill
const GRID_TEMPLATE =
  "minmax(0, 1.6fr) 96px 96px 56px 24px 44px 24px";

const headerCell = {
  ...T.micro,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--heading-secondary)",
  fontWeight: 600,
};

export function WikiRowHeader() {
  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: GRID_TEMPLATE,
        gap: 16,
        alignItems: "center",
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
        background:
          "color-mix(in srgb, var(--heading-secondary) 6%, transparent)",
      }}
    >
      <span style={headerCell}>Wiki</span>
      <span style={headerCell}>Autoregen</span>
      <span style={headerCell}>Last regen</span>
      <span style={{ ...headerCell, textAlign: "right" as const }}>Frags</span>
      <span style={{ ...headerCell, textAlign: "right" as const }}>State</span>
      <span aria-hidden />
      <span aria-hidden />
    </li>
  );
}

interface Props {
  wiki: WikiListEntry;
  onRegenSuccess?: (wikiId: string) => void;
  onRegenError?: (wikiId: string, message: string) => void;
}

export function WikiRow({ wiki, onRegenSuccess, onRegenError }: Props) {
  const toggle = useToggleAutoRegen();
  const regen = useRegenerateWiki();

  // Optimistic snapshot of the autoregen flag. Mirrors the server while
  // the mutation is pending; reverts to wiki.autoregen if the mutation
  // throws.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const checked = optimistic ?? wiki.autoregen ?? false;

  const handleToggle = (next: boolean) => {
    setOptimistic(next);
    toggle.mutate(
      { id: wiki.id, autoregen: next },
      {
        onError: () => {
          setOptimistic(wiki.autoregen ?? false);
        },
        onSuccess: () => {
          setOptimistic(null);
        },
      },
    );
  };

  const handleRegen = () => {
    regen.mutate(wiki.id, {
      onSuccess: () => onRegenSuccess?.(wiki.id),
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Regen failed";
        onRegenError?.(wiki.id, msg);
      },
    });
  };

  const lastRegen = formatTimeAgo(wiki.lastRebuiltAt);
  const needsBackfill =
    wiki.agentSchemaStatus && wiki.agentSchemaStatus !== "complete";

  return (
    <li
      className="settings-wiki-row"
      style={{
        display: "grid",
        gridTemplateColumns: GRID_TEMPLATE,
        gap: 16,
        alignItems: "center",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Link
          href={`/wiki/${wiki.id}?tab=settings`}
          style={{
            ...T.body,
            fontWeight: 500,
            color: "var(--heading-color)",
            textDecoration: "none",
          }}
        >
          {wiki.name}
        </Link>
      </div>

      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={handleToggle}
        disabled={toggle.isPending}
        aria-label={`Toggle autoregen for ${wiki.name}`}
      />

      <span
        title={
          wiki.lastRebuiltAt
            ? new Date(wiki.lastRebuiltAt).toLocaleString()
            : "never"
        }
        style={{ ...T.micro, color: "var(--heading-secondary)" }}
      >
        {lastRegen}
      </span>

      <span
        style={{
          ...T.micro,
          color: "var(--heading-secondary)",
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
        }}
      >
        {wiki.noteCount}
      </span>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <EditorialStateDot
          editorialState={wiki.editorialState ?? "empty"}
          size={10}
        />
      </div>

      {wiki.editorialState === "learning" ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRegen}
          disabled={regen.isPending}
          aria-label={`Regenerate ${wiki.name} now`}
          title="Regenerate now"
        >
          {regen.isPending ? (
            <Spinner className="size-3" />
          ) : (
            <RefreshCw className="size-3" strokeWidth={1.5} />
          )}
        </Button>
      ) : (
        <span aria-hidden />
      )}

      {needsBackfill ? (
        <Link
          href="/admin/backfill"
          title={`Agent schema gap: ${wiki.agentSchemaStatus}`}
          aria-label={`Agent schema gap: ${wiki.agentSchemaStatus}. Open Backfill panel.`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: "50%",
            color: "var(--warning, #b45309)",
          }}
        >
          <AlertCircle className="size-4" strokeWidth={2} />
        </Link>
      ) : (
        <span aria-hidden style={{ width: 18, height: 18 }} />
      )}
    </li>
  );
}

function formatTimeAgo(input: WikiListEntry["lastRebuiltAt"]): string {
  if (!input) return "never";
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return "never";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

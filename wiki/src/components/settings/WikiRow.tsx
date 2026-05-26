"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { T } from "@/lib/typography";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import type { ThreadListResponseSchema } from "@/lib/generated/types.gen";

// The generator emits the wiki list shape under the legacy "thread" alias
// (Thread* mirrors the v0 thread tag in openapi.json). The single wiki
// entry type matches what GET /wikis returns; aliasing here so call
// sites read naturally.
type WikiListEntry = ThreadListResponseSchema["wikis"][number];
import { useToggleAutoRegen } from "@/hooks/useToggleAutoRegen";
import { useRegenerateWiki } from "@/hooks/useRegenerateWiki";

// Stream U: one row per wiki in the settings Wikis panel.
//
// Columns: name + slug, autoregen switch, last regen time, editorial
// state badge, fragment count, regen-now button, agent_schema gap dot.
//
// The autoregen switch flips optimistically; on error the optimistic
// flag reverts so the UI mirrors the server. Regen-now fires the
// existing /wikis/:id/regenerate HTTP route; the toast is owned by
// the parent panel so multiple in-flight regens collapse to one
// notification surface.

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
  // throws. Initialising from props handles the React Query cache update
  // case (the parent re-renders with the new value).
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
    wiki.agentSchemaStatus &&
    wiki.agentSchemaStatus !== "complete";

  return (
    <li
      className="settings-wiki-row"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.6fr) auto auto auto auto auto auto",
        gap: 16,
        alignItems: "center",
        padding: "14px 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Link
          href={`/wiki/${wiki.id}`}
          style={{
            ...T.body,
            fontWeight: 500,
            color: "var(--heading-color)",
            textDecoration: "none",
          }}
        >
          {wiki.name}
        </Link>
        <p
          style={{
            ...T.micro,
            color: "var(--heading-secondary)",
            margin: 0,
            marginTop: 2,
          }}
        >
          /{wiki.slug}
        </p>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
        }}
      >
        <Switch
          size="sm"
          checked={checked}
          onCheckedChange={handleToggle}
          disabled={toggle.isPending}
          aria-label={`Toggle autoregen for ${wiki.name}`}
        />
        <span style={{ ...T.micro, color: "var(--heading-secondary)" }}>
          autoregen
        </span>
      </label>

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

      <Badge
        variant={editorialBadgeVariant(wiki.editorialState)}
        className="text-[10px]"
      >
        {wiki.editorialState ?? "empty"}
      </Badge>

      <span
        style={{
          ...T.micro,
          color: "var(--heading-secondary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {wiki.noteCount} {wiki.noteCount === 1 ? "frag" : "frags"}
      </span>

      <Button
        variant="outline"
        size="sm"
        onClick={handleRegen}
        disabled={regen.isPending}
        aria-label={`Regenerate ${wiki.name} now`}
      >
        {regen.isPending ? (
          <Spinner className="size-3" />
        ) : (
          <RefreshCw className="size-3" strokeWidth={1.5} />
        )}
        regen now
      </Button>

      {needsBackfill ? (
        <Link
          href="/settings/backfill"
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

function editorialBadgeVariant(
  state: WikiListEntry["editorialState"] | undefined,
):
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link" {
  switch (state) {
    case "filed":
      return "default";
    case "dreaming":
      return "secondary";
    case "learning":
      return "outline";
    case "empty":
    default:
      return "ghost";
  }
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

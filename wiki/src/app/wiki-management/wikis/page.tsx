"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { T } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { Toast } from "@/components/ui/toast";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { WikiRow, WikiRowHeader } from "@/components/settings/WikiRow";
import { EditorialStateDot } from "@/components/wiki/EditorialStateDot";
import { useWikis } from "@/hooks/useWikis";
import { useCollections, type Collection } from "@/hooks/useCollections";
import type {
  EditorialStateSchema,
  ThreadListResponseSchema,
} from "@/lib/generated/types.gen";

type WikiListEntry = ThreadListResponseSchema["wikis"][number];

// Display labels for the editorial-state legend on this page. The
// underlying state names (`filed`, `learning`, `dreaming`, `empty`) are
// kept as the source of truth — these strings are operator-facing copy
// scoped to wiki management.
const STATE_ORDER: EditorialStateSchema[] = [
  "filed",
  "learning",
  "dreaming",
  "empty",
];
const STATE_LABELS: Record<EditorialStateSchema, string> = {
  filed: "Up to date",
  learning: "Regen Pending",
  dreaming: "Regenerating Now",
  empty: "Empty Wiki",
};

interface CollectionGroup {
  id: string;
  name: string;
  color: string;
  wikis: WikiListEntry[];
}

const UNCATEGORIZED_ID = "__uncategorized__";

function groupWikisByCollection(
  wikis: WikiListEntry[],
  collections: Collection[],
): CollectionGroup[] {
  const groups: CollectionGroup[] = collections.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color || "var(--wiki-link)",
    wikis: [],
  }));
  const uncategorized: WikiListEntry[] = [];

  for (const wiki of wikis) {
    const wc = wiki.collections ?? [];
    if (wc.length === 0) {
      uncategorized.push(wiki);
      continue;
    }
    for (const c of wc) {
      const target = groups.find((g) => g.id === c.id);
      if (target) target.wikis.push(wiki);
    }
  }

  if (uncategorized.length > 0) {
    groups.push({
      id: UNCATEGORIZED_ID,
      name: "Uncategorized",
      color: "var(--card-border)",
      wikis: uncategorized,
    });
  }

  return groups.filter((g) => g.wikis.length > 0);
}

function stateCounts(wikis: WikiListEntry[]): Record<EditorialStateSchema, number> {
  const counts: Record<EditorialStateSchema, number> = {
    filed: 0,
    learning: 0,
    dreaming: 0,
    empty: 0,
  };
  for (const w of wikis) {
    const s = (w.editorialState ?? "empty") as EditorialStateSchema;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

function StateCounts({ wikis }: { wikis: WikiListEntry[] }) {
  const counts = stateCounts(wikis);
  const visible = STATE_ORDER.filter((s) => counts[s] > 0);
  if (visible.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginRight: 8,
      }}
    >
      {visible.map((s) => (
        <span
          key={s}
          title={`${STATE_LABELS[s]}: ${counts[s]}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            ...T.micro,
            color: "var(--wiki-count)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <EditorialStateDot editorialState={s} size={8} />
          {counts[s]}
        </span>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        marginTop: 12,
        marginBottom: 20,
      }}
    >
      {STATE_ORDER.map((s) => (
        <span
          key={s}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            ...T.micro,
            color: "var(--heading-secondary)",
          }}
        >
          <EditorialStateDot editorialState={s} size={8} />
          {STATE_LABELS[s]}
        </span>
      ))}
    </div>
  );
}

function CollectionSection({
  group,
  expanded,
  onToggle,
  onRegenSuccess,
  onRegenError,
}: {
  group: CollectionGroup;
  expanded: boolean;
  onToggle: () => void;
  onRegenSuccess: (wiki: WikiListEntry) => void;
  onRegenError: (wikiId: string, msg: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--card-border)",
        borderRadius: 8,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "14px 18px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          borderLeft: `4px solid ${group.color}`,
        }}
      >
        <ChevronRight
          size={18}
          style={{
            color: "var(--wiki-count)",
            transform: expanded ? "rotate(90deg)" : "rotate(0)",
            transition: "transform 0.15s ease",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            ...T.h4,
            color: "var(--heading-color)",
            flex: 1,
            fontWeight: 600,
          }}
        >
          {group.name}
        </span>
        <StateCounts wikis={group.wikis} />
        <span
          style={{
            ...T.micro,
            color: "var(--wiki-count)",
            background: "var(--card-border)",
            padding: "3px 10px",
            borderRadius: 12,
            fontWeight: 500,
          }}
        >
          {group.wikis.length} wiki{group.wikis.length === 1 ? "" : "s"}
        </span>
      </button>

      {expanded && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            borderTop: "1px solid var(--card-border)",
            background: "var(--bg)",
          }}
        >
          <WikiRowHeader />
          {group.wikis.map((wiki) => (
            <WikiRow
              key={wiki.id}
              wiki={wiki}
              onRegenSuccess={() => onRegenSuccess(wiki)}
              onRegenError={(id, msg) => onRegenError(id, msg)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SettingsWikisPage() {
  const { data: wikiData, isLoading: wikisLoading, error: wikisError } = useWikis();
  const { data: collections, isLoading: collectionsLoading } = useCollections();
  const [toast, setToast] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const showToast = (message: string) => setToast({ visible: true, message });

  const loading = wikisLoading || collectionsLoading;
  const wikis = wikiData?.wikis ?? [];
  const groups = useMemo(
    () => groupWikisByCollection(wikis, collections ?? []),
    [wikis, collections],
  );

  return (
    <SettingsShell
      title="Wikis"
      subtitle="Grouped by collection. Expand a collection to manage autoregen, trigger on-demand regen, and check agent_schema status."
      backTo="/wiki-management"
      backLabel="Back to wiki management"
    >
      <Legend />

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : wikisError ? (
        <p style={{ ...T.bodySmall, color: "var(--destructive)" }}>
          Failed to load wikis. Try refreshing the page.
        </p>
      ) : groups.length === 0 ? (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--heading-secondary)",
          }}
        >
          <p style={{ ...T.body, margin: 0 }}>No wikis yet.</p>
          <p style={{ ...T.micro, marginTop: 8 }}>
            Capture an entry and the system will spawn its first wiki
            automatically, or create one from the sidebar.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g) => (
            <CollectionSection
              key={g.id}
              group={g}
              expanded={expandedId === g.id}
              onToggle={() =>
                setExpandedId((curr) => (curr === g.id ? null : g.id))
              }
              onRegenSuccess={(wiki) =>
                showToast(`Regen queued for ${wiki.name} (${wiki.id.slice(0, 8)})`)
              }
              onRegenError={(_id, msg) => showToast(`Regen failed: ${msg}`)}
            />
          ))}
        </div>
      )}

      <Toast
        message={toast.message}
        visible={toast.visible}
        onDismiss={() => setToast({ visible: false, message: "" })}
      />
    </SettingsShell>
  );
}

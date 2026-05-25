"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, UserRound, type LucideIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { FONT, T } from "@/lib/typography";
import {
  WikiEntityArticle,
  WikiSectionH2,
} from "@/components/wiki/WikiEntityArticle";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { WikiInfobox } from "@/components/wiki/WikiInfobox";
import { WikiChip } from "@/components/wiki/WikiChip";
import type {
  WikiInfobox as WikiInfoboxData,
  WikiRef,
} from "@/lib/sidecarTypes";
import { ROUTES } from "@/lib/routes";
import { usePerson } from "@/hooks/usePerson";
import { useQueryClient } from "@tanstack/react-query";
import PersonSettingsModal from "@/components/layout/PersonSettingsModal";
import { updatePerson } from "@/lib/api";
import { QuarantineTopbar } from "@/components/wiki/QuarantineTopbar";

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Single-token matcher — expects the whole value to be a `[[kind:slug]]`
 * reference. Matches the canonical WIKI_LINK_RE in
 * `packages/shared/src/wiki-links.ts`. Kept inline here so this page does
 * not reach across the `markdown-token-rendering` phase's file boundary.
 */
const REF_VALUE_RE = /^\s*\[\[([a-z]+):([a-z0-9-]+)\]\]\s*$/;

function hrefForRef(ref: WikiRef): string | undefined {
  switch (ref.kind) {
    case "person":
      return ROUTES.person(ref.id);
    case "fragment":
      return ROUTES.fragment(ref.id);
    case "wiki":
      return ROUTES.wiki(ref.id);
    case "entry":
      return ROUTES.entry(ref.id);
    default:
      return undefined;
  }
}

/**
 * Resolve a row value from the sidecar infobox into a ReactNode for the
 * `<WikiInfobox>` cell. Only `valueKind: 'ref'` gets special handling —
 * every other kind (`text`, `date`, `status`) renders as plain text per
 * the Q7 default in PHASES.md.
 */
function renderInfoboxValue(
  row: WikiInfoboxData["rows"][number],
  refs: Record<string, WikiRef>,
): ReactNode {
  if (row.valueKind === "ref") {
    const match = row.value.match(REF_VALUE_RE);
    if (match) {
      const [, kind, slug] = match;
      const ref = refs[`${kind}:${slug}`];
      if (ref) {
        return (
          <WikiChip
            label={ref.label}
            href={hrefForRef(ref)}
            tokenKind={ref.kind}
            tokenSlug={ref.slug}
          />
        );
      }
    }
    // Unresolved ref — fall back to the raw string so the user still sees
    // something meaningful rather than a silent drop.
    return row.value;
  }
  return row.value;
}

function SettingsIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--wiki-header-icon)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx={12} cy={12} r={3} />
    </svg>
  );
}

function PeopleInfobox({
  person,
  onSettingsClick,
}: {
  person: { relationship: string; updatedAt: string };
  onSettingsClick?: () => void;
}) {
  const label: CSSProperties = {
    ...T.label,
    fontWeight: 700,
    color: "var(--wiki-infobox-title)",
  };

  const body: CSSProperties = {
    ...T.micro,
    color: "var(--wiki-infobox-text)",
    opacity: 0.7,
  };

  return (
    <aside
      className="wiki-aside-infobox"
      style={{
        position: "relative",
        width: 217,
        flexShrink: 0,
        border: "1px solid var(--wiki-card-border)",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        boxSizing: "border-box",
        alignSelf: "flex-start",
      }}
    >
      <button
        type="button"
        aria-label="Infobox settings"
        onClick={() => onSettingsClick?.()}
        style={{
          position: "absolute",
          top: -1,
          right: 0,
          width: 28,
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <SettingsIcon />
      </button>

      {person.relationship && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={label}>Relationship</p>
          <p style={{ ...body, margin: 0 }}>{person.relationship}</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={label}>Last Updated</p>
        <p
          style={{
            ...body,
            color: "var(--wiki-article-link)",
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          {formatDate(person.updatedAt)}
        </p>
      </div>
    </aside>
  );
}

function PeopleFragmentsSection({ backlinks }: { backlinks: Array<{ id: string; title: string }> }) {
  const count = backlinks.length;
  const bodyStyle = {
    ...T.bodySmall,
    color: "var(--wiki-article-text)",
    lineHeight: 1.6,
  };

  return (
    <section style={{ width: "100%" }}>
      <WikiSectionH2 title="Mentioned-in fragments" count={count} />
      {count === 0 ? (
        <p
          style={{
            ...T.bodySmall,
            fontFamily: FONT.SANS,
            fontStyle: "italic",
            color: "var(--wiki-count)",
            margin: "12px 0 0 0",
          }}
        >
          Not mentioned in any fragments
        </p>
      ) : (
        <ul
          style={{
            ...bodyStyle,
            listStyle: "decimal",
            paddingLeft: 20,
            margin: "12px 0 0 0",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {backlinks.map((frag, i) => (
            <li key={i}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Link
                  href={ROUTES.fragment(frag.id)}
                  style={{
                    color: "var(--wiki-fragment-link)",
                    textDecoration: "underline",
                    textDecorationSkipInk: "none",
                  }}
                >
                  {frag.title}
                </Link>
                <Badge
                  variant="outline"
                  className="rounded-full"
                  style={{
                    backgroundColor: "#f5f5f5",
                    color: "#545353",
                    borderColor: "#d1d5db",
                    padding: "2px 10px",
                    ...T.micro,
                  }}
                >
                  mentions
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function WikiPeoplePage() {
  const { id } = useParams<{ id: string }>();
  const { data: person, isLoading, error } = usePerson(id);
  const [personSettingsOpen, setPersonSettingsOpen] = useState(false);
  const queryClient = useQueryClient();

  const bodyStyle = { ...T.bodySmall, color: "var(--wiki-article-text)" };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error || !person) {
    return (
      <div className="p-6">
        <h1 style={T.h1}>Person not found</h1>
        <p style={{ ...T.bodySmall, color: "var(--wiki-article-text)", marginTop: 8 }}>
          This person could not be loaded. They may have been deleted or you may not have access.
        </p>
      </div>
    );
  }

  const backlinks = person.backlinks ?? [];
  const refs: Record<string, WikiRef> = (person.refs ?? {}) as Record<string, WikiRef>;
  const sidecarInfobox: WikiInfoboxData | null =
    (person.infobox ?? null) as WikiInfoboxData | null;

  const handleSaveToApi = async (data: { title: string; chipLabel: string; content: string }) => {
    try {
      await updatePerson({
        path: { id: person.lookupKey },
        body: { name: data.title, content: data.content },
      });
      await queryClient.invalidateQueries({ queryKey: ['person', id] });
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    } catch { /* local state already saved */ }
  };

  // Stream U: pending persons are extractor candidates the operator has
  // not approved yet. Stream P adds the `status` field on the person row
  // ('pending' | 'verified' | 'rejected'). When pending we render a
  // full-width quarantine banner above the page so the operator can
  // approve or reject inline. The cast is intentional — Stream P will
  // regenerate the SDK once it merges, after which the cast can come off.
  const personStatus = (person as unknown as { status?: 'pending' | 'verified' | 'rejected' })
    .status;
  const isPending = personStatus === 'pending';

  return (
    <>
    {isPending ? (
      <QuarantineTopbar personKey={person.lookupKey} personName={person.name} />
    ) : null}
    <Link href="/wiki" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--wiki-count)", textDecoration: "none", marginBottom: 12 }}>
      <ArrowLeft size={14} strokeWidth={1.5} />
      <span style={{ ...T.micro }}>Back</span>
    </Link>
    <WikiEntityArticle
      chipIcon={UserRound as LucideIcon}
      chipLabel="People"
      title={person.name}
      infobox={{ kind: "simple", typeLabel: "People", showSettings: true }}
      renderCustomInfobox={() =>
        sidecarInfobox ? (
          <WikiInfobox
            title={person.name}
            image={sidecarInfobox.image?.url}
            caption={sidecarInfobox.caption}
            sections={[
              {
                rows: sidecarInfobox.rows.map((row) => ({
                  key: row.label,
                  value: renderInfoboxValue(row, refs),
                })),
              },
            ]}
          />
        ) : (
          <PeopleInfobox person={person} onSettingsClick={() => setPersonSettingsOpen(true)} />
        )
      }
      onSave={handleSaveToApi}
      onSettingsClick={() => setPersonSettingsOpen(true)}
      customBottomSections={<PeopleFragmentsSection backlinks={backlinks} />}
    >
      {person.content && (
        <MarkdownContent content={person.content} style={bodyStyle} />
      )}
    </WikiEntityArticle>
    <PersonSettingsModal
      open={personSettingsOpen}
      onClose={() => setPersonSettingsOpen(false)}
      personId={person.lookupKey}
      prefill={{
        name: person.name,
        aliases: person.aliases ?? [],
        relationship: person.relationship ?? "",
      }}
    />
    </>
  );
}

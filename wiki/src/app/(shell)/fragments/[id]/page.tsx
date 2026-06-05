"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type CSSProperties } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import {
  WikiEntityArticle,
  WikiSectionH2,
} from "@/components/wiki/WikiEntityArticle";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useFragment } from "@/hooks/useFragment";
import { useAcceptFragment } from "@/hooks/useAcceptFragment";
import { useRejectFragment } from "@/hooks/useRejectFragment";
import { useQueryClient } from "@tanstack/react-query";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { ROUTES } from "@/lib/routes";
import type { FragmentWithContentResponseSchema } from "@/lib/generated/types.gen";
import { FragmentEvolution } from "./FragmentEvolution";

type FragmentData = Omit<FragmentWithContentResponseSchema, "entryId"> & {
  entryId: string | null;
  backlinks?: Array<{ id: string; name: string; type: string; bouncerMode?: string }>;
  relatedFragments?: Array<{ id: string; slug: string; title: string; similarity: number }>;
  authors?: Array<{ personKey: string; name: string; role: string }>;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function FragmentInfobox({ fragment }: { fragment: FragmentData }) {
  const label: CSSProperties = {
    ...T.micro,
    fontWeight: 700,
    color: "var(--wiki-infobox-title)",
    margin: 0,
  };

  const body: CSSProperties = {
    ...T.micro,
    color: "var(--wiki-infobox-text)",
    opacity: 0.7,
    margin: 0,
  };

  // Stream F2: full lineage view in one place. The infobox now exposes
  // `state` (PENDING/RESOLVED/LINKING/DIRTY) and `updatedAt` so users see
  // the fragment's pipeline status alongside its origin metadata. Source
  // client (mcp/api/web) lives on the parent entry today; surfacing it
  // here would require an extra round-trip and is deferred to A5 once the
  // fragment endpoint denormalises it.
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
      {fragment.authors && fragment.authors.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={label}>Authors</p>
          <p style={body}>{fragment.authors.map((a) => a.name).join(", ")}</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={label}>Type</p>
        <p style={body}>{fragment.type}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={label}>State</p>
        <p style={body}>{fragment.state}</p>
      </div>

      {fragment.tags.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={label}>Tags</p>
          <p style={body}>{fragment.tags.join(", ")}</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={label}>Created</p>
        <p style={body}>{formatDate(fragment.createdAt)}</p>
      </div>

      {fragment.updatedAt && fragment.updatedAt !== fragment.createdAt && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={label}>Updated</p>
          <p style={body}>{formatDate(fragment.updatedAt)}</p>
        </div>
      )}
    </aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p
      style={{
        ...T.bodySmall,
        fontFamily: FONT.SANS,
        fontStyle: "italic",
        color: "var(--wiki-count)",
        margin: "12px 0 0 0",
      }}
    >
      {text}
    </p>
  );
}

function EntryOriginSection({ entryId }: { entryId: string | null }) {
  const bodyStyle = {
    ...T.bodySmall,
    color: "var(--wiki-article-text)",
    lineHeight: 1.6,
  };

  if (!entryId) {
    return (
      <section style={{ width: "100%" }}>
        <WikiSectionH2 title="Source" count={1} />
        <div style={{ margin: "12px 0 0 0" }}>
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
            Created via MCP
          </Badge>
        </div>
      </section>
    );
  }

  return (
    <section style={{ width: "100%" }}>
      <WikiSectionH2 title="Entry origin" count={1} />
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
        <li>
          <Link
            href={ROUTES.entry(entryId)}
            style={{
              color: "var(--wiki-fragment-link)",
              textDecoration: "underline",
              textDecorationSkipInk: "none",
            }}
          >
            View source entry
          </Link>
        </li>
      </ul>
    </section>
  );
}

function BacklinksSection({ backlinks }: { backlinks: Array<{ id: string; name: string; type: string }> }) {
  // Stream F2: stable `id="references"` so any in-page link (or external
  // link of the form `/fragments/<id>#references`) lands on the wikis-
  // citing list. F1's wiki-side superscripts already jump to each wiki's
  // own bibliography (`#fragment-{lookupKey}`); this anchor is the
  // mirror image on the fragment side — "where am I cited from?".
  // `scrollMarginTop` keeps the section header visible under any sticky
  // page chrome.
  return (
    <section id="references" style={{ width: "100%", scrollMarginTop: 80 }}>
      <WikiSectionH2 title="Wiki references" count={backlinks.length} />
      {backlinks.length === 0 ? (
        <EmptyState text="Not filed in any wiki" />
      ) : (
        <ul
          style={{
            ...T.bodySmall,
            color: "var(--wiki-article-text)",
            lineHeight: 1.6,
            listStyle: "decimal",
            paddingLeft: 20,
            margin: "12px 0 0 0",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {backlinks.map((bl) => (
            <li key={bl.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Link
                  href={bl.type === "person" ? ROUTES.person(bl.id) : ROUTES.wiki(bl.id)}
                  style={{
                    color: "var(--wiki-fragment-link)",
                    textDecoration: "underline",
                    textDecorationSkipInk: "none",
                  }}
                >
                  {bl.name}
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
                  {bl.type}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RelatedFragmentsSection({ relatedFragments }: { relatedFragments: Array<{ id: string; slug: string; title: string; similarity: number }> }) {
  if (relatedFragments.length === 0) return null;

  return (
    <section style={{ width: "100%" }}>
      <WikiSectionH2 title="Related fragments" count={relatedFragments.length} />
      <ul
        style={{
          ...T.bodySmall,
          color: "var(--wiki-article-text)",
          lineHeight: 1.6,
          listStyle: "decimal",
          paddingLeft: 20,
          margin: "12px 0 0 0",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {relatedFragments.map((rf) => (
          <li key={rf.id}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <Link
                href={ROUTES.fragment(rf.id)}
                style={{
                  color: "var(--wiki-fragment-link)",
                  textDecoration: "underline",
                  textDecorationSkipInk: "none",
                }}
              >
                {rf.title}
              </Link>
              <span
                style={{
                  ...T.micro,
                  color: "var(--wiki-count)",
                  flexShrink: 0,
                }}
              >
                {Math.round(rf.similarity * 100)}%
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvolutionSection({ fragment }: { fragment: FragmentData }) {
  // Stream F4: edit-history timeline lives on the fragment-detail page
  // itself so the click chain from a wiki citation ends at one surface
  // showing origin + evolution. The component handles its own loading,
  // error, and empty states; we just wrap it in a section heading.
  return (
    <section style={{ width: "100%" }}>
      <WikiSectionH2 title="Evolution" />
      <FragmentEvolution
        fragmentId={fragment.lookupKey}
        currentContent={fragment.content}
      />
    </section>
  );
}

function FragmentBottomSections({ fragment }: { fragment: FragmentData }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40, width: "100%" }}>
      <EntryOriginSection entryId={fragment.entryId} />
      <EvolutionSection fragment={fragment} />
      <BacklinksSection backlinks={fragment.backlinks ?? []} />
      <RelatedFragmentsSection relatedFragments={fragment.relatedFragments ?? []} />
    </div>
  );
}

function FragmentReviewActions({ fragmentId, backlinks }: { fragmentId: string; backlinks: Array<{ id: string; name: string; type: string; bouncerMode?: string }> }) {
  const router = useRouter();
  const accept = useAcceptFragment();
  const reject = useRejectFragment();

  // Only show accept/reject for wikis in review mode
  const reviewBacklinks = backlinks.filter((bl) => bl.type === 'wiki' && bl.bouncerMode === 'review');
  if (reviewBacklinks.length === 0) return null;

  const wikiId = reviewBacklinks[0].id;
  const isPending = accept.isPending || reject.isPending;

  const btnBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    fontSize: 12,
    background: "none",
    border: "1px solid var(--wiki-card-border)",
    cursor: isPending ? "default" : "pointer",
    opacity: isPending ? 0.6 : 1,
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          accept.mutate({ id: fragmentId, wikiId }, {
            onSuccess: () => router.push(`/wiki/${wikiId}`),
          })
        }
        style={{ ...btnBase, color: "#16a34a" }}
      >
        <Check size={14} strokeWidth={1.5} />
        {accept.isPending ? "Accepting..." : "Accept"}
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          reject.mutate({ id: fragmentId, wikiId }, {
            onSuccess: () => router.push(`/wiki/${wikiId}`),
          })
        }
        style={{ ...btnBase, color: "red" }}
      >
        <X size={14} strokeWidth={1.5} />
        {reject.isPending ? "Rejecting..." : "Reject"}
      </button>
      {accept.isSuccess && (
        <span style={{ fontSize: 12, color: "#16a34a" }}>Fragment accepted</span>
      )}
      {reject.isSuccess && (
        <span style={{ fontSize: 12, color: "red" }}>Fragment rejected</span>
      )}
      {(accept.isError || reject.isError) && (
        <span style={{ fontSize: 12, color: "red" }}>
          {accept.isError ? "Failed to accept" : "Failed to reject"}
        </span>
      )}
    </div>
  );
}

export default function FragmentPage() {
  const { id } = useParams<{ id: string }>();
  const { data: fragment, isLoading, error } = useFragment(id);
  const queryClient = useQueryClient();

  const bodyStyle = {
    ...T.bodySmall,
    color: "var(--wiki-article-text)",
    lineHeight: 1.6,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error || !fragment) {
    return (
      <div className="p-6">
        <h1 style={T.h1}>Fragment not found</h1>
        <p style={{ ...T.bodySmall, color: "var(--wiki-article-text)", marginTop: 8 }}>
          This fragment could not be loaded. It may have been deleted or you may not have access.
        </p>
      </div>
    );
  }

  const frag = fragment as FragmentData;
  const backlinks = frag.backlinks ?? [];

  const handleSaveToApi = async (data: { title: string; chipLabel: string; content: string }) => {
    try {
      await fetch(`/api/api/content/fragment/${frag.lookupKey}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontmatter: { title: data.title, tags: frag.tags ?? [] },
          body: data.content,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['fragment', id] });
      await queryClient.invalidateQueries({ queryKey: ['fragments'] });
    } catch { /* local state already saved */ }
  };

  return (
    <>
    <Link href="/wiki" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--wiki-count)", textDecoration: "none", marginBottom: 12 }}>
      <ArrowLeft size={14} strokeWidth={1.5} />
      <span style={{ ...T.micro }}>Back</span>
    </Link>
    <WikiEntityArticle
      chipLabel="Fragment"
      title={frag.title}
      infobox={{ kind: "simple", typeLabel: "Fragment", showSettings: false }}
      renderCustomInfobox={() => <FragmentInfobox fragment={frag} />}
      onSave={handleSaveToApi}
      customBottomSections={
        <>
          <FragmentReviewActions fragmentId={frag.id} backlinks={backlinks} />
          <FragmentBottomSections fragment={frag} />
        </>
      }
    >
      <MarkdownContent content={frag.content} style={bodyStyle} />
    </WikiEntityArticle>
    </>
  );
}

"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Check, LinkIcon, RefreshCw, Trash2, X } from "lucide-react";
import { T } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { useWiki } from "@/hooks/useWiki";
import { useRegenerateWiki } from "@/hooks/useRegenerateWiki";
import { useDeleteWiki } from "@/hooks/useDeleteWiki";
import { useAcceptFragment } from "@/hooks/useAcceptFragment";
import { useRejectFragment } from "@/hooks/useRejectFragment";
import { useQueryClient } from "@tanstack/react-query";
import DestructiveConfirmDialog from "@/components/prompts/DestructiveConfirmDialog";
import SectionEditor from "@/components/editor/SectionEditor";
import {
  WikiEntityArticle,
  WikiSectionH2,
} from "@/components/wiki/WikiEntityArticle";
import { getWikiTypeIcon } from "@/components/wiki/WikiTypeBadge";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { WikiInfobox } from "@/components/wiki/WikiInfobox";
import { WikiChip } from "@/components/wiki/WikiChip";
import { WikiCitations } from "@/components/wiki/WikiCitations";
import { WikiEditLink } from "@/components/wiki/WikiFurniture";
import { SectionedMarkdownBody } from "./SectionedMarkdownBody";
import {
  parseSectionsFromMarkdown,
  replaceSectionInMarkdown,
  type SectionInfo,
} from "@/lib/sectionEdit";
import { useWikiTokenSubstitution } from "@/lib/htmlTokenSubstitute";
import type {
  WikiInfobox as WikiInfoboxData,
  WikiRef,
  WikiSection,
} from "@/lib/sidecarTypes";
import { ROUTES } from "@/lib/routes";

function capitalize(s: string | null | undefined) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Single-token matcher for infobox `valueKind: 'ref'` cells. Mirrors the
 * canonical `WIKI_LINK_RE` in `packages/shared/src/wiki-links.ts` but
 * anchored to the whole value — a row value that is a single token gets
 * chip treatment; anything else falls back to plain text.
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
 * Resolve an infobox row value into a ReactNode. Only `valueKind: 'ref'`
 * gets chip treatment; `text`, `date`, `status` render as plain text per
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
        return <WikiChip label={ref.label} href={hrefForRef(ref)} />;
      }
    }
    return row.value;
  }
  return row.value;
}

/**
 * Inner renderer for the HTML-saved body path. Owns its own container
 * ref so the token-substitution hook can run against the mounted DOM.
 * Must live in its own component so the hook re-runs when `html` changes
 * (e.g. after an edit-mode save round-trip).
 */
function HtmlWikiBody({
  html,
  refs,
  style,
}: {
  html: string;
  refs: Record<string, WikiRef>;
  style: CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useWikiTokenSubstitution(containerRef, html, refs);
  return (
    <div
      ref={containerRef}
      className="wiki-richtext-rendered"
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function WikiDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: _wiki, isLoading, error } = useWiki(id);
  // Extend generated type with fields added in #128 (bouncerMode, edgeStatus)
  // until the OpenAPI codegen picks them up from the live spec
  const wiki = _wiki as typeof _wiki & { bouncerMode?: string; description?: string; fragments?: Array<{ id: string; slug: string; title: string; snippet: string; edgeStatus?: string }> } | undefined;
  const regenerate = useRegenerateWiki();
  const deleteWiki = useDeleteWiki();
  const acceptFragment = useAcceptFragment();
  const rejectFragment = useRejectFragment();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  // Section-scoped edit state. `editingSectionId` doubles as the
  // "dialog open" indicator — non-null ⇒ open. The anchor id is stable
  // across renders as long as the heading text hasn't changed server-side.
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [sectionSaveError, setSectionSaveError] = useState<string | null>(null);
  const [isSavingSection, setIsSavingSection] = useState(false);

  const handleSaveToApi = async (data: { title: string; chipLabel: string; content: string }) => {
    if (!wiki) return;
    try {
      await fetch(`/api/api/content/wiki/${wiki.lookupKey}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontmatter: {
            name: data.title,
            type: data.chipLabel.toLowerCase(),
            prompt: wiki.prompt ?? '',
          },
          body: data.content,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['wiki', id] });
      await queryClient.invalidateQueries({ queryKey: ['wikis'] });
    } catch {
      // Silently fail — local state is already saved
    }
  };

  /**
   * Save a section-scoped edit. Re-parses the current wiki body (not a
   * cached snapshot) so the anchor lookup sees the latest document — if
   * another tab just regenerated the wiki, this gives us a chance to
   * surface a stale-section error rather than overwrite the wrong span.
   *
   * Heading line is preserved verbatim so anchor slugs stay stable; only
   * the body after the heading is replaced with the user's edit.
   */
  const handleSectionSave = async (sectionId: string, editedBody: string) => {
    if (!wiki || typeof wiki.wikiContent !== "string") return;
    const currentBody = wiki.wikiContent;
    const parsedNow = parseSectionsFromMarkdown(currentBody);
    const target = parsedNow.find((s) => s.id === sectionId);
    if (!target) {
      setSectionSaveError(
        "This section no longer exists — the wiki may have been regenerated. Close this dialog and reopen the section you want to edit.",
      );
      return;
    }
    const lines = currentBody.split("\n");
    const headingLine = lines[target.startLine];
    const newSectionBody = `${headingLine}\n${editedBody}`;
    const newFullBody = replaceSectionInMarkdown(
      currentBody,
      sectionId,
      newSectionBody,
    );

    setIsSavingSection(true);
    setSectionSaveError(null);
    try {
      const response = await fetch(`/api/api/content/wiki/${wiki.lookupKey}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frontmatter: {
            name: wiki.name,
            type: wiki.type,
            prompt: wiki.prompt ?? "",
          },
          body: newFullBody,
        }),
      });
      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["wiki", id] });
      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
      setEditingSectionId(null);
    } catch (e) {
      setSectionSaveError(
        e instanceof Error
          ? e.message
          : "Failed to save. Check your connection and try again.",
      );
    } finally {
      setIsSavingSection(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error || !wiki) {
    return (
      <div className="p-6">
        <h1 style={T.h1}>Wiki not found</h1>
        <p style={{ ...T.bodySmall, color: "var(--wiki-article-text)", marginTop: 8 }}>
          This wiki could not be loaded. It may have been deleted or you may not have access.
        </p>
      </div>
    );
  }

  const typeLabel = capitalize(wiki.type);
  const bodyStyle = { ...T.bodySmall, color: "var(--wiki-article-text)" };

  // Sidecar data. Cast against the local hand-mirror types in
  // `@/lib/sidecarTypes` — the generated SDK types are structurally
  // compatible but slightly looser (e.g. `valueKind` is optional on the
  // generated row shape). Fallbacks keep the page safe against older
  // backends that strip sidecar fields (see RESEARCH NQ13).
  const refs: Record<string, WikiRef> = (wiki.refs ?? {}) as Record<string, WikiRef>;
  const sidecarInfobox: WikiInfoboxData | null =
    (wiki.infobox ?? null) as WikiInfoboxData | null;
  const sidecarSections: WikiSection[] =
    (wiki.sections ?? []) as WikiSection[];

  const isHtmlBody =
    typeof wiki.wikiContent === "string" &&
    wiki.wikiContent.trim().startsWith("<");

  // Resolve the currently-editing section's heading + body-only prefill.
  // Parses the live wiki content so a mid-session regeneration is
  // detected at dialog-open time — if the anchor no longer resolves,
  // `editingHeading` stays empty and the dialog surfaces a stale-anchor
  // message synthesized below instead of showing an empty editor.
  let editingHeading = "";
  let editingInitialBody = "";
  let sectionMissing = false;
  if (
    editingSectionId &&
    typeof wiki.wikiContent === "string" &&
    !isHtmlBody
  ) {
    const parsedForEdit = parseSectionsFromMarkdown(wiki.wikiContent);
    const target = parsedForEdit.find((s) => s.id === editingSectionId);
    if (target) {
      editingHeading = target.heading;
      const lines = wiki.wikiContent.split("\n");
      editingInitialBody = lines
        .slice(target.startLine + 1, target.endLine + 1)
        .join("\n");
    } else {
      sectionMissing = true;
      editingHeading = editingSectionId;
    }
  }
  const dialogError =
    sectionMissing && !sectionSaveError
      ? "This section no longer exists on the current wiki — it may have been regenerated while you weren't looking. Close this dialog and pick a section from the current page."
      : sectionSaveError;

  return (
    <WikiEntityArticle
      chipIcon={getWikiTypeIcon(typeLabel)}
      chipLabel={typeLabel}
      title={wiki.name}
      promptOverride={wiki.prompt}
      description={wiki.description ?? wiki.shortDescriptor ?? ''}
      bouncerMode={wiki.bouncerMode as 'auto' | 'review' | undefined}
      published={wiki.published === true}
      publishedSlug={wiki.publishedSlug ?? null}
      infobox={{ kind: "simple", typeLabel, lastUpdated: wiki.updatedAt, showSettings: true }}
      renderCustomInfobox={
        sidecarInfobox
          ? () => (
              <WikiInfobox
                title={wiki.name}
                image={sidecarInfobox.image?.url}
                caption={sidecarInfobox.caption}
                sections={[
                  {
                    rows: sidecarInfobox.rows.map(
                      (row: WikiInfoboxData["rows"][number]) => ({
                        key: row.label,
                        value: renderInfoboxValue(row, refs),
                      }),
                    ),
                  },
                ]}
              />
            )
          : undefined
      }
      wikiId={wiki.id}
      onSave={handleSaveToApi}
      customBottomSections={
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => regenerate.mutate(wiki.id)}
              disabled={regenerate.isPending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12,
                color: "var(--wiki-article-text)",
                background: "none",
                border: "1px solid var(--wiki-card-border)",
                cursor: regenerate.isPending ? "default" : "pointer",
                opacity: regenerate.isPending ? 0.6 : 1,
              }}
            >
              <RefreshCw
                size={14}
                strokeWidth={1.5}
                style={regenerate.isPending ? { animation: "spin 1s linear infinite" } : undefined}
              />
              {regenerate.isPending ? "Regenerating..." : "Regenerate"}
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleteWiki.isPending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12,
                color: "red",
                background: "none",
                border: "1px solid var(--wiki-card-border)",
                cursor: deleteWiki.isPending ? "default" : "pointer",
                opacity: deleteWiki.isPending ? 0.6 : 1,
              }}
            >
              <Trash2 size={14} strokeWidth={1.5} />
              {deleteWiki.isPending ? "Deleting..." : "Delete Wiki"}
            </button>
            {wiki.published && wiki.publishedSlug && (
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/p/${wiki.publishedSlug}`;
                  navigator.clipboard.writeText(url);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2000);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  fontSize: 12,
                  color: "var(--wiki-article-link)",
                  background: "none",
                  border: "1px solid var(--wiki-card-border)",
                  cursor: "pointer",
                }}
              >
                {shareCopied ? (
                  <Check size={14} strokeWidth={1.5} />
                ) : (
                  <LinkIcon size={14} strokeWidth={1.5} />
                )}
                {shareCopied ? "Copied!" : "Copy share link"}
              </button>
            )}
            {regenerate.isSuccess && (
              <span style={{ fontSize: 12, color: "var(--wiki-article-link)" }}>
                Regeneration queued
              </span>
            )}
            {regenerate.isError && (
              <span style={{ fontSize: 12, color: "red" }}>
                Failed to regenerate
              </span>
            )}
            {deleteWiki.isError && (
              <span style={{ fontSize: 12, color: "red" }}>
                Failed to delete
              </span>
            )}
          </div>
          <DestructiveConfirmDialog
            open={showDeleteConfirm}
            onOpenChange={setShowDeleteConfirm}
            title="Delete Wiki"
            description="Are you sure? This permanently deletes this wiki."
            confirmText={wiki.name}
            confirmLabel="Delete"
            onConfirm={() => {
              deleteWiki.mutate(wiki.id, {
                onSuccess: () => router.push("/wiki"),
              });
            }}
          />
        </>
      }
    >
      {wiki.wikiContent && (
        isHtmlBody ? (
          // HTML body (Tiptap-saved): the remark plugin never runs on this
          // branch, so token substitution is done by a post-render DOM
          // walker (`useWikiTokenSubstitution`). Server-computed
          // `sections[]` were derived from markdown and their anchors may
          // not line up with the HTML structure, so citations are
          // rendered as a trailing flat list keyed by section heading
          // rather than injected per-section (MVP option b in the
          // phase spec).
          <>
            <div data-wiki-body>
              <HtmlWikiBody
                html={wiki.wikiContent}
                refs={refs}
                style={bodyStyle}
              />
            </div>
            {sidecarSections.length > 0 && (
              <div
                style={{
                  marginTop: 16,
                  paddingTop: 12,
                  borderTop: "1px solid var(--wiki-card-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {sidecarSections
                  .filter((section) => (section.citations ?? []).length > 0)
                  .map((section) => (
                    <div
                      key={section.anchor}
                      style={{ ...bodyStyle, display: "flex", gap: 8, alignItems: "baseline" }}
                    >
                      <span style={{ opacity: 0.7 }}>
                        {section.heading}
                      </span>
                      <WikiCitations citations={section.citations ?? []} />
                    </div>
                  ))}
              </div>
            )}
          </>
        ) : (
          // Markdown body (LLM-emitted): `<MarkdownContent>` owns token
          // substitution via `remarkWikiTokens` when refs is passed.
          // Rendering section-by-section lets us append `<WikiCitations>`
          // after each section's prose.
          //
          // `onEditSection` enables the per-heading `[edit]` bracket
          // affordance. It's wired here (not on the HTML branch) because
          // section-scoped editing requires markdown fidelity — when the
          // body has been round-tripped through Tiptap HTML, the [[token]]
          // syntax and fenced blocks don't survive cleanly. Q9 default
          // option (b): hide the affordance on HTML-saved bodies. The
          // user is told to regenerate to re-enable it.
          <div data-wiki-body>
            <SectionedMarkdownBody
              content={wiki.wikiContent}
              refs={refs}
              sections={sidecarSections}
              style={bodyStyle}
              onEditSection={(sectionId) => {
                setSectionSaveError(null);
                setEditingSectionId(sectionId);
              }}
            />
          </div>
        )
      )}
      <SectionEditor
        open={editingSectionId !== null}
        onOpenChange={(next) => {
          if (!next) {
            setEditingSectionId(null);
            setSectionSaveError(null);
          }
        }}
        heading={editingHeading}
        initialBody={editingInitialBody}
        isSaving={isSavingSection}
        error={dialogError}
        onSave={(body) => {
          if (editingSectionId && !sectionMissing) {
            void handleSectionSave(editingSectionId, body);
          }
        }}
      />

      {wiki.fragments && wiki.fragments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <WikiSectionH2 title="Member Fragments" count={wiki.fragments.length} />
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
            {wiki.fragments.map((frag) => (
              <li key={frag.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                {wiki.bouncerMode === "review" && (frag as typeof frag & { edgeStatus?: string }).edgeStatus === "pending" && (
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <button
                      type="button"
                      title="Accept fragment"
                      onClick={() => acceptFragment.mutate({ id: frag.id, wikiId: wiki.id })}
                      disabled={acceptFragment.isPending}
                      style={{
                        background: "none",
                        border: "1px solid var(--wiki-card-border)",
                        cursor: "pointer",
                        padding: "2px 4px",
                        display: "inline-flex",
                        alignItems: "center",
                        color: "green",
                      }}
                    >
                      <Check size={12} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      title="Reject fragment"
                      onClick={() => rejectFragment.mutate({ id: frag.id, wikiId: wiki.id })}
                      disabled={rejectFragment.isPending}
                      style={{
                        background: "none",
                        border: "1px solid var(--wiki-card-border)",
                        cursor: "pointer",
                        padding: "2px 4px",
                        display: "inline-flex",
                        alignItems: "center",
                        color: "red",
                      }}
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                    <span style={{ fontSize: 10, color: "var(--wiki-count)", fontStyle: "italic" }}>pending</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {wiki.people && wiki.people.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <WikiSectionH2 title="Mentioned People" count={wiki.people.length} />
          <ul
            style={{
              ...bodyStyle,
              listStyle: "disc",
              paddingLeft: 20,
              margin: "12px 0 0 0",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {wiki.people.map((person) => (
              <li key={person.id}>
                <Link
                  href={ROUTES.person(person.id)}
                  style={{
                    color: "var(--wiki-fragment-link)",
                    textDecoration: "underline",
                    textDecorationSkipInk: "none",
                  }}
                >
                  {person.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </WikiEntityArticle>
  );
}

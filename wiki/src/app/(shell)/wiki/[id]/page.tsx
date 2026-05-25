"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Check, LinkIcon, RefreshCw, Trash2 } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { useWiki } from "@/hooks/useWiki";
import { useRegenerateWiki } from "@/hooks/useRegenerateWiki";
import { useDeleteWiki } from "@/hooks/useDeleteWiki";
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
import { WikiCitationsSection } from "@/components/wiki/WikiCitationsSection";
import { WikiEditLink } from "@/components/wiki/WikiFurniture";
import { MemberFragmentsManagementTable } from "@/components/wiki/MemberFragmentsManagementTable";
import { BouncerModeToggle } from "@/components/wiki/BouncerModeToggle";
import { SectionedMarkdownBody } from "./SectionedMarkdownBody";
import {
  parseSectionsFromMarkdown,
  replaceSectionInMarkdown,
  type SectionInfo,
} from "@/lib/sectionEdit";
import { useWikiTokenSubstitution } from "@/lib/htmlTokenSubstitute";
import type { FragmentCitationMap } from "@/components/wiki/MarkdownContent";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import { EditorialStateDot } from "@/components/wiki/EditorialStateDot";
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
 * anchored to the whole value — used when the row contains exactly one
 * token. Multi-token values use REF_TOKEN_GLOBAL_RE below.
 */
const REF_VALUE_RE = /^\s*\[\[([a-z]+):([a-z0-9-]+)\]\]\s*$/;

/**
 * Global matcher for finding every `[[kind:slug]]` token inside an
 * infobox value. Used to render multi-ref rows like
 * `[[wiki:foo]], [[wiki:bar]], [[wiki:baz]]` — each token becomes a
 * chip and the separating text (commas, "and", whitespace) renders as
 * plain text between chips.
 */
const REF_TOKEN_GLOBAL_RE = /\[\[([a-z]+):([a-z0-9-]+)\]\]/g;

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
  if (row.valueKind !== "ref") return row.value;

  // Fast path: single token spans the whole value.
  const singleMatch = row.value.match(REF_VALUE_RE);
  if (singleMatch) {
    const [, kind, slug] = singleMatch;
    const ref = refs[`${kind}:${slug}`];
    if (ref) return (
      <WikiChip
        label={ref.label}
        href={hrefForRef(ref)}
        tokenKind={ref.kind}
        tokenSlug={ref.slug}
      />
    );
    return row.value;
  }

  // Multi-token: walk every [[kind:slug]] in the string, emit chips for
  // resolvable tokens, and preserve separating text (commas, "and", etc.)
  // between them. Falls back to plain text for tokens whose ref is
  // missing from the refs map.
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hasToken = false;
  const re = new RegExp(REF_TOKEN_GLOBAL_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(row.value)) !== null) {
    hasToken = true;
    const [whole, kind, slug] = match;
    if (match.index > cursor) {
      parts.push(row.value.slice(cursor, match.index));
    }
    const ref = refs[`${kind}:${slug}`];
    if (ref) {
      parts.push(
        <WikiChip
          key={parts.length}
          label={ref.label}
          href={hrefForRef(ref)}
          tokenKind={ref.kind}
          tokenSlug={ref.slug}
        />,
      );
    } else {
      parts.push(whole);
    }
    cursor = match.index + whole.length;
  }
  if (!hasToken) return row.value;
  if (cursor < row.value.length) parts.push(row.value.slice(cursor));
  return <>{parts}</>;
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
  fragmentCitationMap,
}: {
  html: string;
  refs: Record<string, WikiRef>;
  style: CSSProperties;
  fragmentCitationMap?: FragmentCitationMap;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useWikiTokenSubstitution(containerRef, html, refs, fragmentCitationMap);
  return (
    <div
      ref={containerRef}
      className="wiki-richtext-rendered"
      style={style}
      dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(html) }}
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
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // Phase 2: Fragments tab edit mode toggle. When false, fragment actions
  // (un-attach, attach) and Regenerate are hidden. Mirrors the view-to-edit
  // pattern used for Settings.
  const [fragmentsManageMode, setFragmentsManageMode] = useState(false);

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

  // #351 -- build a document-wide citation number map for the HTML body
  // path. The markdown path builds its own inside SectionedMarkdownBody.
  const htmlFragmentCitationMap: FragmentCitationMap = (() => {
    const map: FragmentCitationMap = new Map();
    let n = 1;
    for (const section of sidecarSections) {
      for (const c of section.citations ?? []) {
        if (!map.has(c.fragmentId)) {
          map.set(c.fragmentId, n++);
        }
      }
    }
    return map;
  })();

  // Set of fragment IDs that are cited anywhere in the current wiki body.
  // Drives the Fragments-tab status column (cited vs uncited) so the user
  // can tell which attached fragments are actually doing work in this wiki
  // and which are dormant.
  const citedFragmentIds = new Set<string>(htmlFragmentCitationMap.keys());

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
    <>
    <WikiEntityArticle
      chipIcon={getWikiTypeIcon(typeLabel)}
      chipLabel={typeLabel}
      title={wiki.name}
      promptOverride={wiki.prompt}
      structureOverride={wiki.structure ?? ''}
      description={wiki.description ?? wiki.shortDescriptor ?? ''}
      bouncerMode={wiki.bouncerMode as 'auto' | 'review' | undefined}
      published={wiki.published === true}
      publishedSlug={wiki.publishedSlug ?? null}
      publishedOrigin={wiki.publishedOrigin ?? null}
      collections={wiki.collections ?? []}
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
      onDeleteWiki={() => setShowDeleteConfirm(true)}
      onRegenerateWiki={() => regenerate.mutate(wiki.id)}
      regenerateBusy={regenerate.isPending}
      editorialStateDot={{
        editorialState: wiki.editorialState,
        state: wiki.state,
        dirtySince: wiki.dirtySince,
        lastRebuiltAt: wiki.lastRebuiltAt,
      }}
      onSave={handleSaveToApi}
      fragmentsTabContent={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Manage / Done toggle gates fragment-write actions and the
              Regenerate button. Read mode shows the list only. The tab
              label already says "Fragments", so no in-content heading. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ ...T.bodySmall, fontFamily: FONT.SANS, color: "var(--wiki-count)" }}>
              {wiki.fragments?.length ?? 0} fragments
            </span>
            <div style={{ flex: 1 }} />
            {fragmentsManageMode ? (
              <>
                <button
                  type="button"
                  onClick={() => regenerate.mutate(wiki.id)}
                  disabled={regenerate.isPending}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 16px",
                    fontSize: 13,
                    fontFamily: FONT.SANS,
                    color: "#fff",
                    background: "var(--wiki-link)",
                    border: "1px solid var(--wiki-link)",
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
                  onClick={() => setFragmentsManageMode(false)}
                  style={{
                    padding: "6px 16px",
                    fontSize: 13,
                    fontFamily: FONT.SANS,
                    color: "var(--wiki-article-text)",
                    background: "none",
                    border: "1px solid var(--wiki-card-border)",
                    cursor: "pointer",
                  }}
                >
                  Done
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setFragmentsManageMode(true)}
                style={{
                  padding: "6px 16px",
                  fontSize: 13,
                  fontFamily: FONT.SANS,
                  color: "#fff",
                  background: "var(--wiki-link)",
                  border: "1px solid var(--wiki-link)",
                  cursor: "pointer",
                }}
              >
                Manage Fragments
              </button>
            )}
          </div>
          <MemberFragmentsManagementTable
            wikiId={wiki.id}
            fragments={wiki.fragments ?? []}
            manageMode={fragmentsManageMode}
            citedFragmentIds={citedFragmentIds}
          />
        </div>
      }
      customBottomSections={
        <>
          {/* Phase 2: BouncerModeToggle, Regenerate, and Delete Wiki moved
              off Read: BouncerModeToggle + Delete go into Settings; Regenerate
              moves to the Fragments tab (Manage mode). Share link stays here
              for now since it's a Read-mode discoverability action. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
          {/* DestructiveConfirmDialog moved to a sibling of WikiEntityArticle
              below so it stays mounted when the user clicks Delete from the
              Settings tab (customBottomSections unmounts on Settings). */}
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
                fragmentCitationMap={htmlFragmentCitationMap}
              />
            </div>
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
            />
          </div>
        )
      )}
      {/* #245 — document-wide citations section. Flatten every section's
          citations into a single list (preserving order); the component
          dedups by lookupKey internally so a fragment cited from
          multiple sections appears once at the bottom and every
          superscript anchor lands on the same row. */}
      {(() => {
        const allCitations = sidecarSections.flatMap((s) => s.citations ?? []);
        if (allCitations.length === 0) return null;
        return (
          <details style={{ paddingTop: 20, width: "100%" }}>
            <summary
              style={{
                cursor: "pointer",
                margin: 0,
                ...T.h2,
                color: "var(--wiki-article-h2)",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                userSelect: "none",
                listStyle: "revert",
              }}
            >
              <span>Citations</span>
              <span style={{ ...T.bodySmall, fontFamily: FONT.SANS, fontWeight: 400, color: "var(--wiki-count)" }}>
                ({new Set(allCitations.map((c) => c.fragmentId)).size})
              </span>
            </summary>
            <div style={{ marginTop: 8 }}>
              <WikiCitationsSection heading="" citations={allCitations} />
            </div>
          </details>
        );
      })()}
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

      {/* Member Fragments moved to the dedicated Fragments tab. */}

      {wiki.people && wiki.people.length > 0 && (
        <details style={{ paddingTop: 20, width: "100%" }}>
          <summary
            style={{
              cursor: "pointer",
              margin: 0,
              ...T.h2,
              color: "var(--wiki-article-h2)",
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              userSelect: "none",
              listStyle: "revert",
            }}
          >
            <span>Mentioned People</span>
            <span style={{ ...T.bodySmall, fontFamily: FONT.SANS, fontWeight: 400, color: "var(--wiki-count)" }}>
              ({wiki.people.length})
            </span>
          </summary>
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
        </details>
      )}

      {/* Timeline moved into the History tab (merged with revisions). */}
    </WikiEntityArticle>
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
  );
}

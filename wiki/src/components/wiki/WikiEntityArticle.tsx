"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AddWikiModal, {
  type WikiSettingsFormHandle,
  type WikiSettingsFormMode,
} from "@/components/layout/AddWikiModal";
import InlineEditor from "@/components/editor/InlineEditor";
import { WikiDiffInline } from "@/components/wiki/WikiDiffInline";
import WikiHistoryTimeline from "@/components/wiki/WikiHistoryTimeline";
import WikiRegenTimeline from "@/components/wiki/WikiRegenTimeline";
import { T, FONT } from "@/lib/typography";
import {
  EDITABLE_WIKI_TYPES,
  getWikiTypeColors,
  getWikiTypeIcon,
  isPeopleWikiType,
  WikiTypeBadge,
  type WikiType,
} from "@/components/wiki/WikiTypeBadge";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { useWikiEntityEditMode, type WikiRevision } from "@/components/wiki/useWikiEntityEditMode";
import { useWikiEditHistory } from "@/hooks/useWikiEditHistory";
import { wikiEntitySettingsPrefill } from "@/lib/wikiSettingsPrefill";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import {
  type LucideIcon,
} from "lucide-react";
import { EditorialStateDot, type EditorialStateDotProps } from "@/components/wiki/EditorialStateDot";

function EyeOpenIcon() {
  return (
    <svg width={17} height={13} viewBox="0 0 17 13" fill="none" aria-hidden>
      <path
        d="M8.5 0.25C4.636 0.25 1.34 2.66 0 6.25C1.34 9.84 4.636 12.25 8.5 12.25C12.364 12.25 15.66 9.84 17 6.25C15.66 2.66 12.364 0.25 8.5 0.25ZM8.5 10.25C6.291 10.25 4.5 8.459 4.5 6.25C4.5 4.041 6.291 2.25 8.5 2.25C10.709 2.25 12.5 4.041 12.5 6.25C12.5 8.459 10.709 10.25 8.5 10.25ZM8.5 4.25C7.395 4.25 6.5 5.145 6.5 6.25C6.5 7.355 7.395 8.25 8.5 8.25C9.605 8.25 10.5 7.355 10.5 6.25C10.5 5.145 9.605 4.25 8.5 4.25Z"
        fill="var(--foreground)"
      />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width={17} height={15} viewBox="0 0 17 15" fill="none" aria-hidden>
      <path
        d="M8.5 2.5C10.709 2.5 12.5 4.291 12.5 6.5C12.5 7.02 12.39 7.51 12.21 7.97L14.54 10.3C15.77 9.29 16.73 7.99 17 6.5C15.66 2.91 12.364 0.5 8.5 0.5C7.474 0.5 6.49 0.68 5.57 0.99L7.28 2.7C7.74 2.52 8.22 2.5 8.5 2.5ZM0.94 1.37L2.69 3.12L3.08 3.51C1.73 4.55 0.68 5.93 0 6.5C1.34 10.09 4.636 12.5 8.5 12.5C9.63 12.5 10.71 12.28 11.71 11.89L12.08 12.26L14.38 14.56L15.33 13.61L1.89 0.42L0.94 1.37ZM5.18 5.61L6.32 6.75C6.29 6.83 6.27 6.92 6.27 7C6.27 8.105 7.165 9 8.27 9C8.35 9 8.44 8.98 8.52 8.95L9.66 10.09C9.24 10.3 8.78 10.43 8.27 10.43C6.061 10.43 4.27 8.639 4.27 6.43C4.27 5.92 4.4 5.46 4.61 5.04L5.18 5.61ZM8.36 4.08L10.69 6.41L10.71 6.27C10.71 5.165 9.815 4.27 8.71 4.27L8.36 4.08Z"
        fill="var(--foreground)"
      />
    </svg>
  );
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

const infoboxLabel = {
  ...T.micro,
  fontWeight: 700 as const,
  color: "var(--wiki-infobox-title)",
};

const infoboxBodyMuted = {
  ...T.micro,
  color: "var(--wiki-infobox-text)",
  opacity: 0.7,
};

export function WikiInfoboxTypeUpdated({
  typeLabel,
  lastUpdated,
}: {
  typeLabel: string;
  lastUpdated?: string;
  /** @deprecated #250: gear lives on the toolbar; this prop is now ignored. */
  showSettings?: boolean;
  /** @deprecated #250: gear lives on the toolbar; this prop is now ignored. */
  onSettingsClick?: () => void;
}) {
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={infoboxLabel}>Type</p>
        <p style={{ ...infoboxBodyMuted, margin: 0 }}>{typeLabel}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={infoboxLabel}>Last Updated</p>
        <p
          style={{
            ...infoboxBodyMuted,
            color: "var(--wiki-article-link)",
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          {lastUpdated ?? "—"}
        </p>
      </div>
    </aside>
  );
}

export function WikiInfoboxGoalStyle({
  typeValue,
  startedAt,
  targetDate,
  momentum,
  lastUpdated,
}: {
  typeValue: string;
  startedAt?: string;
  targetDate?: string;
  momentum?: string;
  lastUpdated?: string;
  /** @deprecated #250: gear lives on the toolbar; this prop is now ignored. */
  showSettings?: boolean;
  /** @deprecated #250: gear lives on the toolbar; this prop is now ignored. */
  onSettingsClick?: () => void;
}) {
  const linkValue = {
    ...infoboxBodyMuted,
    color: "var(--wiki-article-link)",
    margin: 0 as const,
    whiteSpace: "nowrap" as const,
  };

  const rows: { label: string; value: string; link?: boolean }[] = [
    { label: "Type", value: typeValue, link: false },
    { label: "Started", value: startedAt ?? "—", link: true },
    { label: "Target", value: targetDate ?? "—", link: true },
    { label: "Momentum", value: momentum ?? "—", link: true },
    { label: "Last Updated", value: lastUpdated ?? "—", link: true },
  ];

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
        ...T.micro,
      }}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <p style={infoboxLabel}>{row.label}</p>
          <p
            style={
              row.link
                ? linkValue
                : { ...infoboxBodyMuted, margin: 0, whiteSpace: "normal" }
            }
          >
            {row.value}
          </p>
        </div>
      ))}
    </aside>
  );
}

export function WikiSectionH2({ title, count }: { title: string; count?: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        paddingTop: 20,
        width: "100%",
      }}
    >
      <h2
        style={{
          margin: 0,
          ...T.h2,
          color: "var(--wiki-article-h2)",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span>{title}</span>
        {count !== undefined ? (
          <span
            style={{
              ...T.bodySmall,
              fontFamily: FONT.SANS,
              fontWeight: 400,
              color: "var(--wiki-count)",
            }}
          >
            ({count})
          </span>
        ) : null}
      </h2>
      <div
        style={{
          height: 1,
          width: "100%",
          background: "var(--wiki-meta-line)",
        }}
      />
    </div>
  );
}

export type WikiEntityInfoboxConfig =
  | { kind: "simple"; typeLabel: string; lastUpdated?: string; showSettings?: boolean }
  | { kind: "extended"; typeValue: string; startedAt?: string; targetDate?: string; momentum?: string; lastUpdated?: string; showSettings?: boolean };

export type WikiEntityArticleProps = {
  chipIcon?: LucideIcon;
  chipLabel: string;
  title: string;
  titleEllipsis?: boolean;
  /** Figma agent: divider under title row is hidden */
  showTitleUnderline?: boolean;
  /** Show/hide infobox panel + eye toggle button */
  showInfobox?: boolean;
  infobox: WikiEntityInfoboxConfig;
  /**
   * Optional custom infobox renderer used by pages that keep the shared shell
   * but need a type-specific infobox content/layout.
   */
  renderCustomInfobox?: () => ReactNode;
  /**
   * Optional sections rendered after divider and before modal.
   */
  customBottomSections?: ReactNode;
  /**
   * Content rendered in the dedicated "Fragments" tab. Caller owns the
   * fragment management surface (typically <MemberFragmentsManagementTable>).
   * When this prop is provided AND the user clicks the Fragments tab, the
   * main content area swaps to this node and Read/Edit/History content
   * are hidden.
   */
  fragmentsTabContent?: ReactNode;
  /** Per-wiki Wiki Style override to prefill in settings modal (wikis.prompt). */
  promptOverride?: string;
  /** Per-wiki Wiki Format override to prefill in settings modal (wikis.structure). */
  structureOverride?: string;
  /** Wiki description / shortDescriptor to prefill in settings modal */
  description?: string;
  /** Current bouncer mode for settings modal prefill */
  bouncerMode?: 'auto' | 'review';
  /** Current publish state — feeds the publish toggle in settings modal (#255). */
  published?: boolean;
  /** Public published-wiki nanoid slug (when published) for share-link UI. */
  publishedSlug?: string | null;
  /** Origin recorded at publish time. Drives the clickable URL when
   *  the user is browsing from a different host (Stream I Phase 4). */
  publishedOrigin?: string | null;
  /** Current collection memberships — feeds the Collections section in the modal. */
  collections?: Array<{ id: string; name: string; slug: string; color: string }>;
  /** Real wiki id for settings-mode PUT. Prototype pages omit → 'preview' sentinel. */
  wikiId?: string;
  /** Called after local save completes — persist to backend here. */
  onSave?: (data: { title: string; chipLabel: string; content: string }) => void;
  /** Custom settings click handler — when provided, the header gear calls this instead of opening AddWikiModal. */
  onSettingsClick?: () => void;
  /**
   * Optional delete-wiki callback. Forwarded to the Settings-tab form's
   * Delete Wiki button. Host owns the confirm dialog + mutation; this
   * component just triggers it when the user clicks Delete.
   */
  onDeleteWiki?: () => void;
  /**
   * Optional regenerate-wiki callback. When provided, a Regenerate button
   * renders in the Settings tab's action row alongside Edit Wiki Settings /
   * Save (only while fields are unlocked). The host owns the mutation; this
   * component just triggers it.
   */
  onRegenerateWiki?: () => void;
  /** Disables the Settings-tab Regenerate button + shows "Regenerating…". */
  regenerateBusy?: boolean;
  /** Editorial state dot rendered inline with the title. */
  editorialStateDot?: EditorialStateDotProps;
  children: ReactNode;
};

function renderInfobox(
  config: WikiEntityInfoboxConfig,
  onSettingsClick?: () => void,
) {
  if (config.kind === "simple") {
    return (
      <WikiInfoboxTypeUpdated
        typeLabel={config.typeLabel}
        lastUpdated={config.lastUpdated}
        showSettings={config.showSettings}
        onSettingsClick={onSettingsClick}
      />
    );
  }
  return (
    <WikiInfoboxGoalStyle
      typeValue={config.typeValue}
      startedAt={config.startedAt}
      targetDate={config.targetDate}
      momentum={config.momentum}
      lastUpdated={config.lastUpdated}
      showSettings={config.showSettings}
      onSettingsClick={onSettingsClick}
    />
  );
}

export function WikiEntityArticle({
  chipIcon: ChipIcon,
  chipLabel,
  title,
  titleEllipsis = false,
  showTitleUnderline = true,
  showInfobox = true,
  infobox,
  renderCustomInfobox,
  customBottomSections,
  fragmentsTabContent,
  promptOverride,
  structureOverride,
  description,
  wikiId,
  bouncerMode,
  published,
  publishedSlug,
  publishedOrigin,
  collections,
  onSave,
  onSettingsClick: onSettingsClickProp,
  onDeleteWiki,
  onRegenerateWiki,
  regenerateBusy = false,
  editorialStateDot,
  children,
}: WikiEntityArticleProps) {
  const [infoVisible, setInfoVisible] = useState(true);
  // Tab and URL sync (Phase 2). ?tab=fragments / ?tab=history reflects
  // state so the user can deep-link or refresh-with-tab-preserved. Edit
  // isn't synced because it's a write-in-progress mode; coming back via
  // URL would lose the draft anyway.
  //
  // The initial tab is read once from the URL via the useState
  // initializer (which runs only on mount), avoiding a cascading
  // setState in useEffect.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Fragments and Settings render inline in the main content area (no modal).
  // The modal mode of AddWikiModal is still used by the global header's
  // "+ New" create flow; hosts can also override via `onSettingsClickProp`
  // (e.g. preview pages) to keep their own popup.
  const [isViewingFragments, setIsViewingFragments] = useState(
    () => searchParams.get("tab") === "fragments",
  );
  const [isViewingSettings, setIsViewingSettings] = useState(
    () => searchParams.get("tab") === "settings",
  );
  // Settings form: parent-rendered primary button + delete confirmation
  // live above the embedded form panel, so we expose the form's submit
  // via ref and track its mode for the button label.
  const settingsFormRef = useRef<WikiSettingsFormHandle>(null);
  const [settingsMode, setSettingsMode] = useState<WikiSettingsFormMode>("view");
  // Edit-mode diff toggle: when on, swap the InlineEditor for a
  // read-only word-diff view in the same column space. Off by default
  // so editing is the primary state; user opts in to "see what
  // changed" when they want it. Effect below resets it on edit-mode
  // exit so re-entering Edit always lands in the editor view.
  const [showEditDiff, setShowEditDiff] = useState(false);
  // True once the InlineEditor has mounted and reseated the baseline for
  // the current Edit session. Subsequent editor mounts (e.g. after
  // toggling Show changes off) must NOT re-anchor the baseline, or
  // user-typed edits get re-classified as pristine and Save / Cancel
  // disappear mid-edit. Reset in the effect that runs on isEditing=false.
  const baselineAnchoredRef = useRef(false);
  const readContentRef = useRef<HTMLDivElement | null>(null);

  const updateTabInUrl = (tab: "read" | "fragments" | "history" | "settings" | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!tab || tab === "read") params.delete("tab");
    else params.set("tab", tab);
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname);
  };

  const { data: historyData } = useWikiEditHistory(wikiId);
  const serverRevisions = useMemo<WikiRevision[] | undefined>(() => {
    if (!historyData?.edits?.length) return undefined;
    return historyData.edits.map((edit) => ({
      id: edit.id,
      timestamp: new Date(edit.timestamp).getTime(),
      title: '',
      chipLabel: '',
      content: edit.contentSnippet,
      summary: edit.source === 'regen' ? 'Regenerated' : 'Edited',
      author: edit.source === 'regen' ? 'Robin' : 'You',
    }));
  }, [historyData]);

  const {
    isEditing,
    isDirty,
    isViewingHistory,
    draftContent,
    savedContent,
    baselineContent,
    draftTitle,
    savedTitle,
    draftChipLabel,
    savedChipLabel,
    revisions,
    setDraftContent,
    setDraftTitle,
    setDraftChipLabel,
    setBaselineContent,
    enterEditMode,
    openHistory,
    closeHistory,
    handleSave,
    handleCancel,
  } = useWikiEntityEditMode({
    infoVisible,
    setInfoVisible,
    serverRevisions,
  });

  // Reset Edit-session ephemera when isEditing flips off:
  //  - diff toggle so re-entering Edit lands in the editor
  //  - baseline-anchored flag so the NEXT Edit session reseats baseline
  //    from a fresh Tiptap normalization (the one for the new editor
  //    instance, not the one we cached last session).
  useEffect(() => {
    if (!isEditing) {
      setShowEditDiff(false);
      baselineAnchoredRef.current = false;
    }
  }, [isEditing]);

  const displayTitle = savedTitle ?? title;
  const displayChipLabel = savedChipLabel ?? chipLabel;
  const displayChipIcon = getWikiTypeIcon(displayChipLabel);
  const draftChipColors = getWikiTypeColors(draftChipLabel);
  const wikiTypeLocked = isPeopleWikiType(displayChipLabel);
  // #250: settings gear is permanent next to the eye toggle whenever the
  // hosting page has somewhere to send the click — i.e. we have a real wiki
  // id (sentinel 'preview' counts as a real id for prototype pages) OR the
  // page has wired its own onSettingsClick handler. Pages that explicitly
  // opt out (Fragments) pass infobox.showSettings === false; honour that.
  const settingsOptedOut = infobox.showSettings === false;
  const hasSettingsTarget = Boolean(wikiId) || Boolean(onSettingsClickProp);
  const showSettings = !settingsOptedOut && hasSettingsTarget;

  const wikiSettingsPrefill = useMemo(
    () => ({
      ...wikiEntitySettingsPrefill({
        title: displayTitle,
        chipLabel: displayChipLabel,
        description,
        promptOverride,
        structureOverride,
      }),
      bouncerMode,
      published,
      publishedSlug,
      publishedOrigin,
      collections,
    }),
    [displayTitle, displayChipLabel, description, promptOverride, structureOverride, bouncerMode, published, publishedSlug, publishedOrigin, collections],
  );

  const tabs = ["Read", "Edit", "Fragments", "History", "Settings"] as const;

  return (
    <div className="wiki-page wiki-page--article">
      <div
        style={{
          width: "100%",
          maxWidth: 864,
          display: "flex",
          flexDirection: "column",
          gap: 48,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 24,
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              width: "100%",
            }}
          >
            {/* Top metadata row: collections on the left, Wiki Type badge +
                editorial-state dot + Private indicator on the right. Type
                change is owned by Settings only (not Edit). */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                width: "100%",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {(collections ?? []).map((c) => (
                  <span
                    key={c.id}
                    data-slot="wiki-collection-chip"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 8px",
                      ...T.micro,
                      fontFamily: FONT.SANS,
                      color: "var(--wiki-article-text)",
                      border: "1px solid var(--wiki-card-border)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: c.color || "var(--wiki-count)",
                      }}
                      aria-hidden
                    />
                    {c.name}
                  </span>
                ))}
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <WikiTypeBadge type={displayChipLabel} icon={displayChipIcon ?? ChipIcon} />
                {editorialStateDot && <EditorialStateDot {...editorialStateDot} />}
                {/* Private badge renders identically across all 5 sub-pages
                    alongside the Type badge and editorial-state dot. */}
                {published === false && (
                  <span
                    data-testid="wiki-private-badge"
                    aria-label="Private"
                    style={{
                      ...T.micro,
                      color: "var(--wiki-infobox-text)",
                      opacity: 0.7,
                      fontFamily: FONT.SANS,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    Private
                  </span>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                width: "100%",
                padding: "4px 8px",
              }}
            >
              <div
                className="wiki-article-title-wrap"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 8,
                  width: "100%",
                  borderBottom: showTitleUnderline
                    ? "1px solid var(--wiki-search-section-line)"
                    : "none",
                }}
              >
                {/* Title is identical across all modes (Read / Edit / Fragments /
                    History / Settings). Title rename lives in Settings (along
                    with type change). */}
                <h1
                  className="wiki-article-h1"
                  style={{
                    margin: 0,
                    paddingBottom: 8,
                    ...T.h1,
                    fontFamily: FONT.SERIF,
                    color: "var(--wiki-title)",
                    overflow: titleEllipsis ? "hidden" : undefined,
                    textOverflow: titleEllipsis ? "ellipsis" : undefined,
                    whiteSpace: titleEllipsis ? "nowrap" : undefined,
                    minWidth: 0,
                    flex: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {displayTitle}
                </h1>
                {/* Phase 2: editorial-state dot + Private badge moved up
                    next to the Wiki Type badge so the title has the full
                    horizontal lane. */}
                <div
                  className="wiki-article-tabs"
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "flex-end",
                    gap: 12,
                    flexShrink: 0,
                    flexWrap: "wrap",
                  }}
                >
                  {/* Tabs render identically across all modes. Save / Cancel
                      for Edit live inline below the editor, not in the tab bar. */}
                  {tabs.map((tab) => {
                      const active =
                        (tab === "Read" && !isEditing && !isViewingHistory && !isViewingFragments && !isViewingSettings) ||
                        (tab === "Edit" && isEditing) ||
                        (tab === "Fragments" && isViewingFragments) ||
                        (tab === "History" && isViewingHistory) ||
                        (tab === "Settings" && isViewingSettings);
                      return (
                        <button
                          key={tab}
                          type="button"
                          className={
                            active
                              ? "wiki-article-tab wiki-article-tab-active"
                              : "wiki-article-tab"
                          }
                          onClick={() => {
                            // Scope the read-mode HTML capture to the `[data-wiki-body]`
                            // subtree so sidebar chrome (Member Fragments,
                            // Mentioned People, citations, etc.) never leaks
                            // into the Tiptap draft and gets baked into
                            // `wikis.content` on save (#241). Fall back to the
                            // wrapper innerHTML for callers that haven't opted
                            // in yet (e.g. the People page).
                            //
                            // Within the body, three passes so citation
                            // tokens roundtrip cleanly through Tiptap:
                            //  1. Replace inline citation chips
                            //     (wiki-citation / wiki-citation-inline)
                            //     with plain-text `[[fragment:slug]]`
                            //     tokens. Read-mode's
                            //     useWikiTokenSubstitution will swap them
                            //     back to numbered chips at render time.
                            //  2. Unwrap the citations wrapper span
                            //     (wiki-citations): keep its now-text
                            //     children, drop the wrapper. Otherwise
                            //     pass 3 would remove the wrapper AND
                            //     the text tokens inside it.
                            //  3. Strip remaining [data-slot] affordances
                            //     (edit-link, references, see-also, hint,
                            //     citations-section, etc.) which are interactive
                            //     UI, not author content.
                            let bodyHtml = "";
                            const bodyEl = readContentRef.current?.querySelector("[data-wiki-body]");
                            if (bodyEl) {
                              const clone = bodyEl.cloneNode(true) as HTMLElement;
                              clone
                                .querySelectorAll(
                                  '[data-slot="wiki-citation"], [data-slot="wiki-citation-inline"]',
                                )
                                .forEach((n) => {
                                  const slug = (n as HTMLElement).dataset.fragmentSlug;
                                  if (slug) {
                                    n.replaceWith(
                                      document.createTextNode(`[[fragment:${slug}]]`),
                                    );
                                  } else {
                                    n.remove();
                                  }
                                });
                              // Cross-reference chips (`[[kind:slug]]` for
                              // person / wiki / entry) round-trip back
                              // to their text-token form using the
                              // data-token-* attributes baked into the
                              // rendered chip by WikiChip + the runtime
                              // walker. Skip if either attr is missing
                              // (legacy chips without the round-trip
                              // metadata fall through to the strip pass).
                              clone
                                .querySelectorAll('[data-slot="wiki-chip"]')
                                .forEach((n) => {
                                  const el = n as HTMLElement;
                                  const kind = el.dataset.tokenKind;
                                  const slug = el.dataset.tokenSlug;
                                  if (kind && slug) {
                                    n.replaceWith(
                                      document.createTextNode(`[[${kind}:${slug}]]`),
                                    );
                                  } else {
                                    n.remove();
                                  }
                                });
                              clone
                                .querySelectorAll('[data-slot="wiki-citations"]')
                                .forEach((n) => {
                                  const parent = n.parentNode;
                                  if (!parent) return;
                                  while (n.firstChild) parent.insertBefore(n.firstChild, n);
                                  parent.removeChild(n);
                                });
                              clone.querySelectorAll("[data-slot]").forEach((n) => n.remove());
                              bodyHtml = clone.innerHTML;
                            } else {
                              bodyHtml = readContentRef.current?.innerHTML ?? "";
                            }
                            // Edit mode is exclusive: the editor branch
                            // wins the content render, so any other tab
                            // click is a no-op visually until edit mode
                            // exits. Auto-exit when pristine (nothing
                            // to lose). When dirty, block the nav, since
                            // Save / Cancel are visible above to resolve
                            // explicitly.
                            if (tab !== "Edit" && isEditing) {
                              if (isDirty) return;
                              handleCancel();
                            }
                            if (tab === "Edit") {
                              setIsViewingFragments(false);
                              setIsViewingSettings(false);
                              enterEditMode({
                                currentHtml: bodyHtml,
                                currentTitle: displayTitle,
                                currentChipLabel: displayChipLabel,
                              });
                              updateTabInUrl(null);
                            } else if (tab === "Fragments") {
                              if (isViewingHistory) closeHistory();
                              setIsViewingSettings(false);
                              setIsViewingFragments(true);
                              setInfoVisible(false);
                              updateTabInUrl("fragments");
                            } else if (tab === "History") {
                              setIsViewingFragments(false);
                              setIsViewingSettings(false);
                              openHistory({
                                currentHtml: bodyHtml,
                                currentTitle: displayTitle,
                                currentChipLabel: displayChipLabel,
                              });
                              updateTabInUrl("history");
                            } else if (tab === "Settings") {
                              // Settings renders inline as its own page now.
                              // The legacy modal path (onSettingsClickProp) is
                              // still respected for hosts that wire their own
                              // handler, e.g. preview / prototype pages.
                              if (onSettingsClickProp) {
                                onSettingsClickProp();
                              } else {
                                if (isViewingHistory) closeHistory();
                                setIsViewingFragments(false);
                                setInfoVisible(false);
                                setIsViewingSettings(true);
                              }
                              updateTabInUrl("settings");
                            } else if (tab === "Read") {
                              setIsViewingFragments(false);
                              setIsViewingSettings(false);
                              if (isViewingHistory) closeHistory();
                              updateTabInUrl(null);
                            }
                          }}
                          style={{
                            background: "none",
                            borderTop: "none",
                            borderLeft: "none",
                            borderRight: "none",
                            cursor: "pointer",
                            ...T.bodySmall,
                            fontFamily: FONT.SANS,
                            lineHeight: "20px",
                            paddingBottom: 8,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {tab}
                        </button>
                      );
                    })}
                  {showInfobox && !isEditing && !isViewingHistory && !isViewingFragments && !isViewingSettings ? (
                    <button
                      type="button"
                      title={infoVisible ? "Hide infobox" : "Show infobox"}
                      onClick={() => setInfoVisible((v) => !v)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        paddingBottom: 12,
                      }}
                    >
                      {infoVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                    </button>
                  ) : null}
                  {/* Settings gear icon removed; Settings is now a tab. */}
                </div>
              </div>
            </div>
          </div>

          {/* Page-action row: sits below the tab bar, above the content
              box. Hosts mode-specific buttons:
                - Edit mode: Save / Cancel (only while isDirty, since no point
                  saving or bailing out before anything's changed)
                - Settings tab → Edit Wiki Settings / Save (label tracks
                  the embedded form's mode via WikiSettingsFormHandle).
              Right-aligned to match the tab bar. */}
          {isEditing && isDirty && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 12,
                paddingBottom: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setShowEditDiff((v) => !v)}
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
                {showEditDiff ? "Hide changes" : "Show changes"}
              </button>
              <button
                type="button"
                onClick={() => {
                  handleSave();
                  onSave?.({
                    title: draftTitle || title,
                    chipLabel: draftChipLabel || chipLabel,
                    content: draftContent,
                  });
                }}
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
                Save
              </button>
              <button
                type="button"
                onClick={handleCancel}
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
                Cancel
              </button>
            </div>
          )}
          {isViewingSettings && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 12,
                paddingBottom: 12,
              }}
            >
              {/* Regenerate lives in the Settings action row too, so it's
                  surfaceable from somewhere other than the Fragments tab
                  (which is easy to miss). Only shows once the form is
                  unlocked, mirroring the Delete Wiki button's gating
                  (destructive / heavyweight actions require entering edit
                  mode first). */}
              {settingsMode === "edit" && onRegenerateWiki && (
                <button
                  type="button"
                  onClick={() => onRegenerateWiki()}
                  disabled={regenerateBusy}
                  style={{
                    padding: "6px 16px",
                    fontSize: 13,
                    fontFamily: FONT.SANS,
                    color: "var(--wiki-article-text)",
                    background: "none",
                    border: "1px solid var(--wiki-card-border)",
                    cursor: regenerateBusy ? "default" : "pointer",
                    opacity: regenerateBusy ? 0.6 : 1,
                  }}
                >
                  {regenerateBusy ? "Regenerating…" : "Regenerate"}
                </button>
              )}
              <button
                type="button"
                onClick={() => settingsFormRef.current?.submit()}
                disabled={settingsMode === "submitting"}
                style={{
                  padding: "6px 16px",
                  fontSize: 13,
                  fontFamily: FONT.SANS,
                  color: "#fff",
                  background: "var(--wiki-link)",
                  border: "1px solid var(--wiki-link)",
                  cursor: settingsMode === "submitting" ? "default" : "pointer",
                  opacity: settingsMode === "submitting" ? 0.6 : 1,
                }}
              >
                {settingsMode === "submitting"
                  ? "Saving…"
                  : settingsMode === "edit"
                    ? "Save"
                    : "Edit Wiki Settings"}
              </button>
            </div>
          )}

          {/*
            Structured `.winfo` infobox (sidecar-driven) renders inline as
            the first child of `.wiki-article-content` so prose body wraps
            around it via `float: right` (globals.css `.winfo`). #251 +
            G2 right-column fix. The legacy 217px `.wiki-aside-infobox`
            variants (renderInfobox) keep their side-rail flex slot.
          */}
          <div
            className="wiki-article-layout"
            style={{
              display: "flex",
              gap: 16,
              alignItems: "flex-start",
              width: "100%",
            }}
          >
            <div
              className="wiki-article-content"
              style={{
                flex: 1,
                minWidth: 0,
                // G2: flow-root establishes a block formatting context so
                // `.winfo` (rendered first child) can float right and the
                // body markdown wraps around it. `display: flex` would
                // turn children into flex items and ignore the float.
                display: "flow-root",
              }}
            >
              {showInfobox && infoVisible && !isEditing && !isViewingHistory && !isViewingFragments && !isViewingSettings && renderCustomInfobox
                ? renderCustomInfobox()
                : null}
              {isEditing ? (
                // Show-changes toggle swaps the editor for a read-only
                // word-diff view in the same column slot. Same green-add
                // / red-strikethrough treatment as the History tab.
                showEditDiff && isDirty ? (
                  <WikiDiffInline
                    beforeHtml={baselineContent}
                    afterHtml={draftContent}
                  />
                ) : (
                  <InlineEditor
                    content={draftContent}
                    onChange={setDraftContent}
                    editable
                    onReady={(normalized) => {
                      // Tiptap reformats the input on mount: citations,
                      // unknown attrs, etc. get stripped. Reseat both
                      // baseline and draft to that normalized snapshot
                      // so a pristine editor reads as !isDirty.
                      //
                      // Only do this ONCE per Edit session. The editor
                      // re-mounts when the user toggles Show changes
                      // on/off, and re-anchoring there would wipe
                      // isDirty mid-edit and disappear Save / Cancel.
                      if (baselineAnchoredRef.current) return;
                      baselineAnchoredRef.current = true;
                      setBaselineContent(normalized);
                      setDraftContent(normalized);
                    }}
                  />
                )
              ) : isViewingHistory ? (
                // Phase 2: History is the unified stream. WikiRegenTimeline
                // already merges /history (edit revisions) + /timeline (audit
                // events) internally, so we use it as-is. WikiHistoryTimeline
                // (the older revision-only view) stays as a fallback when we
                // don't have a wikiId.
                wikiId ? <WikiRegenTimeline wikiId={wikiId} /> : <WikiHistoryTimeline revisions={revisions} />
              ) : isViewingFragments ? (
                fragmentsTabContent ?? (
                  <div style={{ ...T.bodySmall, color: "var(--muted-foreground)" }}>
                    No fragments tab content provided by this page.
                  </div>
                )
              ) : isViewingSettings ? (
                // Inline Settings tab: renders the same form the legacy gear
                // modal used, embedded directly in the article column. The
                // page-level title h1 + tab bar already supply chrome, so
                // `embedded` strips the DialogHeader.
                <AddWikiModal
                  ref={settingsFormRef}
                  embedded
                  hideFooter
                  open={false}
                  onClose={() => {
                    setIsViewingSettings(false);
                    updateTabInUrl(null);
                  }}
                  title="Wiki Settings"
                  confirmLabel="Edit Wiki Settings"
                  prefill={wikiSettingsPrefill}
                  wikiId={wikiId ?? "preview"}
                  onDelete={onDeleteWiki}
                  onModeChange={setSettingsMode}
                />
              ) : (
                <div ref={readContentRef}>
                  {savedContent ? (
                    <div
                      className="wiki-richtext-rendered"
                      dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(savedContent) }}
                    />
                  ) : (
                    children
                  )}
                </div>
              )}
            </div>

            {showInfobox && infoVisible && !isEditing && !isViewingHistory && !isViewingFragments && !isViewingSettings && !renderCustomInfobox
              ? (
                  <div className="hidden md:block">
                    {renderInfobox(infobox)}
                  </div>
                )
              : null}
          </div>
        </div>

        {/* customBottomSections (citations + mentioned-people + share button)
            hide in the Fragments and Settings tabs since those tabs own the
            entire content area. Read, Edit, History still show them. */}
        {!isViewingFragments && !isViewingSettings && customBottomSections}
      </div>

    </div>
  );
}

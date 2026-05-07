"use client";

import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import AddWikiModal from "@/components/layout/AddWikiModal";
import InlineEditor from "@/components/editor/InlineEditor";
import WikiHistoryTimeline from "@/components/wiki/WikiHistoryTimeline";
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
  /** Per-wiki prompt override to prefill in settings modal */
  promptOverride?: string;
  /** Wiki description / shortDescriptor to prefill in settings modal */
  description?: string;
  /** Current bouncer mode for settings modal prefill */
  bouncerMode?: 'auto' | 'review';
  /** Current publish state — feeds the publish toggle in settings modal (#255). */
  published?: boolean;
  /** Public published-wiki nanoid slug (when published) for share-link UI. */
  publishedSlug?: string | null;
  /** Current collection memberships — feeds the Collections section in the modal. */
  collections?: Array<{ id: string; name: string; slug: string; color: string }>;
  /** Real wiki id for settings-mode PUT. Prototype pages omit → 'preview' sentinel. */
  wikiId?: string;
  /** Called after local save completes — persist to backend here. */
  onSave?: (data: { title: string; chipLabel: string; content: string }) => void;
  /** Custom settings click handler — when provided, the header gear calls this instead of opening AddWikiModal. */
  onSettingsClick?: () => void;
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
  promptOverride,
  description,
  wikiId,
  bouncerMode,
  published,
  publishedSlug,
  collections,
  onSave,
  onSettingsClick: onSettingsClickProp,
  children,
}: WikiEntityArticleProps) {
  const [infoVisible, setInfoVisible] = useState(true);
  const [wikiSettingsOpen, setWikiSettingsOpen] = useState(false);
  const readContentRef = useRef<HTMLDivElement | null>(null);

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
    isViewingHistory,
    draftContent,
    savedContent,
    draftTitle,
    savedTitle,
    draftChipLabel,
    savedChipLabel,
    revisions,
    setDraftContent,
    setDraftTitle,
    setDraftChipLabel,
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
      ...wikiEntitySettingsPrefill({ title: displayTitle, chipLabel: displayChipLabel, description, promptOverride }),
      bouncerMode,
      published,
      publishedSlug,
      collections,
    }),
    [displayTitle, displayChipLabel, description, promptOverride, bouncerMode, published, publishedSlug, collections],
  );

  const tabs = ["Read", "Edit", "View history"] as const;

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
            {isEditing ? (
              wikiTypeLocked ? (
                <div style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
                  <WikiTypeBadge type={displayChipLabel} icon={displayChipIcon} />
                </div>
              ) : (
                <div
                  style={{
                    display: "inline-flex",
                    flexDirection: "column",
                    gap: 0,
                    alignItems: "flex-start",
                  }}
                >
                  <Combobox
                    value={draftChipLabel}
                    items={EDITABLE_WIKI_TYPES}
                    filter={null}
                    onValueChange={(value) => setDraftChipLabel(String(value))}
                  >
                    <ComboboxTrigger
                      className="inline-flex w-fit items-center gap-1 rounded-sm border border-border bg-white text-xs [&>svg]:text-black"
                      render={<button type="button" />}
                      style={{
                        paddingLeft: 6,
                        paddingRight: 6,
                        paddingTop: 3,
                        paddingBottom: 3,
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          backgroundColor: draftChipColors.bg,
                          color: "var(--foreground)",
                          borderColor: draftChipColors.border,
                          borderWidth: 1,
                          borderStyle: "solid",
                          borderRadius: 2,
                          padding: "2px 8px",
                          lineHeight: "16px",
                        }}
                      >
                        {(() => {
                          const DraftIcon = getWikiTypeIcon(draftChipLabel);
                          return DraftIcon ? <DraftIcon /> : null;
                        })()}
                        <ComboboxValue />
                      </span>
                    </ComboboxTrigger>
                    <ComboboxContent className="rounded-none px-2 py-1">
                      <ComboboxEmpty>No wiki type found.</ComboboxEmpty>
                      <ComboboxList>
                        <ComboboxCollection>
                          {(item) => {
                            const type = item as WikiType;
                            return (
                              <ComboboxItem value={type}>
                                <WikiTypeBadge type={type} />
                              </ComboboxItem>
                            );
                          }}
                        </ComboboxCollection>
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </div>
              )
            ) : (
              <WikiTypeBadge type={displayChipLabel} icon={displayChipIcon ?? ChipIcon} />
            )}

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
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  width: "100%",
                  borderBottom: showTitleUnderline
                    ? "1px solid var(--wiki-search-section-line)"
                    : "none",
                }}
              >
                {isEditing ? (
                  <input
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    aria-label="Wiki title"
                    style={{
                      margin: 0,
                      paddingBottom: 8,
                      ...T.h1,
                      fontFamily: FONT.SERIF,
                      color: "var(--wiki-title)",
                      minWidth: 0,
                      flex: 1,
                      border: "none",
                      outline: "none",
                      background: "transparent",
                    }}
                  />
                ) : (
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
                    }}
                  >
                    {displayTitle}
                  </h1>
                )}
                <div
                  className="wiki-article-tabs"
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    gap: 12,
                    flexShrink: 0,
                  }}
                >
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="wiki-article-tab"
                        onClick={() => {
                          handleSave();
                          onSave?.({ title: draftTitle || title, chipLabel: draftChipLabel || chipLabel, content: draftContent });
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
                        Save
                      </button>
                      <button
                        type="button"
                        className="wiki-article-tab-muted"
                        onClick={handleCancel}
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
                        Cancel
                      </button>
                    </>
                  ) : (
                    tabs.map((tab) => {
                      const active =
                        (tab === "Read" && !isViewingHistory) ||
                        (tab === "View history" && isViewingHistory);
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
                            // Within the body, strip `[data-slot]` affordances
                            // (the inline `[edit]` link rendered by
                            // `WikiEditLink`, citation superscripts, etc.) —
                            // they are interactive UI, not author content, and
                            // round-tripping them turns live affordances into
                            // inert markup permanently baked into the body.
                            let bodyHtml = "";
                            const bodyEl = readContentRef.current?.querySelector("[data-wiki-body]");
                            if (bodyEl) {
                              const clone = bodyEl.cloneNode(true) as HTMLElement;
                              clone.querySelectorAll("[data-slot]").forEach((n) => n.remove());
                              bodyHtml = clone.innerHTML;
                            } else {
                              bodyHtml = readContentRef.current?.innerHTML ?? "";
                            }
                            if (tab === "Edit") {
                              enterEditMode({
                                currentHtml: bodyHtml,
                                currentTitle: displayTitle,
                                currentChipLabel: displayChipLabel,
                              });
                            } else if (tab === "View history") {
                              openHistory({
                                currentHtml: bodyHtml,
                                currentTitle: displayTitle,
                                currentChipLabel: displayChipLabel,
                              });
                            } else if (tab === "Read") {
                              if (isViewingHistory) closeHistory();
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
                    })
                  )}
                  {showInfobox && !isEditing && !isViewingHistory ? (
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
                  {showSettings && !isEditing && !isViewingHistory ? (
                    <button
                      type="button"
                      title="Wiki settings"
                      onClick={() => onSettingsClickProp ? onSettingsClickProp() : setWikiSettingsOpen(true)}
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
                      <SettingsIcon />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {/*
            Structured `.winfo` infobox (sidecar-driven) renders ABOVE the
            article body at full content width — issue #251. The legacy
            217px `.wiki-aside-infobox` variants (renderInfobox) keep their
            side-rail slot below.
          */}
          {showInfobox && infoVisible && !isEditing && !isViewingHistory && renderCustomInfobox
            ? (
                <div className="wiki-article-infobox-above" style={{ width: "100%" }}>
                  {renderCustomInfobox()}
                </div>
              )
            : null}

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
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {isEditing ? (
                <InlineEditor
                  content={draftContent}
                  onChange={setDraftContent}
                  editable
                />
              ) : isViewingHistory ? (
                <WikiHistoryTimeline revisions={revisions} />
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

            {showInfobox && infoVisible && !isEditing && !isViewingHistory && !renderCustomInfobox
              ? (
                  <div className="hidden md:block">
                    {renderInfobox(infobox)}
                  </div>
                )
              : null}
          </div>
        </div>

        {customBottomSections}
      </div>

      <AddWikiModal
        open={wikiSettingsOpen}
        onClose={() => setWikiSettingsOpen(false)}
        title="Wiki Settings"
        confirmLabel="Edit Wiki Settings"
        prefill={wikiSettingsPrefill}
        wikiId={wikiId ?? "preview"}
      />
    </div>
  );
}

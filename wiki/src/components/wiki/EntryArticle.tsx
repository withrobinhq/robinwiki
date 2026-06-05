"use client";

import { useState, type ReactNode } from "react";
import { T, FONT } from "@/lib/typography";
import { WikiTypeBadge } from "@/components/wiki/WikiTypeBadge";

/**
 * EntryArticle — shell for entry pages.
 *
 * Cloned from WikiEntityArticle but stripped of:
 *  - View history tab
 *  - Wiki-type chip (replaced with a static grey "Entry" badge)
 *  - Inline body editor (body is static read-only HTML / children)
 *  - Wiki settings modal
 *
 * Edit mode only exposes the title as editable.
 */

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

export type EntryInfoboxProps = {
  type: string;
  source: string;
  createdAt: string;
  authors?: Array<{ personKey: string; name: string; role: string }>;
};

export function EntryInfobox({ type, source, createdAt, authors }: EntryInfoboxProps) {
  const rows: { label: string; value: string }[] = [
    ...(authors && authors.length > 0
      ? [{ label: "Authors", value: authors.map((a) => a.name).join(", ") }]
      : []),
    { label: "Type", value: type },
    { label: "Source", value: source },
    { label: "Created", value: createdAt },
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
          <p style={{ ...infoboxBodyMuted, margin: 0, whiteSpace: "normal" }}>
            {row.value}
          </p>
        </div>
      ))}
    </aside>
  );
}

export type EntryArticleProps = {
  title: string;
  /** Content for Read mode. Children render below the body layout — use for
   *  sections like "Extracted Fragments". */
  body: ReactNode;
  infobox: EntryInfoboxProps;
  children?: ReactNode;
  /** Called when user clicks Save in Edit mode. Returns true to accept, false to cancel. */
  onTitleSave?: (newTitle: string) => void;
  titleEllipsis?: boolean;
  showTitleUnderline?: boolean;
};

export function EntryArticle({
  title,
  body,
  infobox,
  children,
  onTitleSave,
  titleEllipsis = false,
  showTitleUnderline = true,
}: EntryArticleProps) {
  const [infoVisible, setInfoVisible] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [savedTitle, setSavedTitle] = useState(title);

  const displayTitle = savedTitle;

  const enterEditMode = () => {
    setDraftTitle(savedTitle);
    setIsEditing(true);
  };

  const handleSave = () => {
    setSavedTitle(draftTitle);
    onTitleSave?.(draftTitle);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setDraftTitle(savedTitle);
    setIsEditing(false);
  };

  const tabs = ["Read", "Edit"] as const;
  const activeTab = isEditing ? "Edit" : "Read";

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
            {/* Chip — unified "Entry" badge via WikiTypeBadge (grey, iconless) */}
            <div>
              <WikiTypeBadge type="Entry" />
            </div>

            {/* Title + tabs row */}
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
                    onChange={(e) => setDraftTitle(e.target.value)}
                    aria-label="Entry title"
                    autoFocus
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
                        onClick={handleSave}
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
                      const active = tab === activeTab;
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
                            if (tab === "Edit") enterEditMode();
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

                  {!isEditing ? (
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
                </div>
              </div>
            </div>
          </div>

          {/* Body + infobox layout */}
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
              {body}
            </div>

            {infoVisible && !isEditing ? (
              <div className="hidden md:block">
                <EntryInfobox {...infobox} />
              </div>
            ) : null}
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

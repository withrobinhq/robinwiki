"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { generateUlid } from "@robin/shared/browser";
import { htmlToPlainText } from "./wikiDiff";

type UseWikiEntityEditModeArgs = {
  infoVisible: boolean;
  setInfoVisible: (visible: boolean) => void;
  serverRevisions?: WikiRevision[];
};

export type WikiRevision = {
  id: string;
  timestamp: number;
  title: string;
  chipLabel: string;
  content: string;
  summary: string;
  author: string;
};

export type WikiEntityEditMode = {
  isEditing: boolean;
  isViewingHistory: boolean;
  isDirty: boolean;
  draftContent: string;
  savedContent: string | null;
  /** Snapshot of body HTML at the moment enterEditMode() ran. */
  baselineContent: string;
  draftTitle: string;
  savedTitle: string | null;
  draftChipLabel: string;
  savedChipLabel: string | null;
  revisions: WikiRevision[];
  setDraftContent: (value: string) => void;
  setDraftTitle: (value: string) => void;
  setDraftChipLabel: (value: string) => void;
  /** Reseat the baseline used by isDirty + the diff preview. The
   *  editor normalizes HTML on mount (StarterKit strips unknown tags,
   *  reformats attribute order, etc.), so the raw HTML we passed into
   *  enterEditMode doesn't match what Tiptap produces. Once the editor
   *  emits its post-mount snapshot, callers reseat baseline + draft to
   *  that snapshot so a pristine editor reads as !isDirty. */
  setBaselineContent: (value: string) => void;
  enterEditMode: (args: {
    currentHtml: string;
    currentTitle: string;
    currentChipLabel: string;
  }) => void;
  openHistory: (args: {
    currentHtml: string;
    currentTitle: string;
    currentChipLabel: string;
  }) => void;
  closeHistory: () => void;
  handleSave: () => void;
  handleCancel: () => void;
};

const diffSummary = (prev: WikiRevision | null, next: Omit<WikiRevision, "id" | "timestamp" | "summary" | "author">) => {
  if (!prev) return "Initial revision";
  const changes: string[] = [];
  if (prev.title !== next.title) changes.push("title");
  if (prev.chipLabel !== next.chipLabel) changes.push("type");
  if (prev.content !== next.content) {
    const prevLen = prev.content.length;
    const nextLen = next.content.length;
    const delta = nextLen - prevLen;
    changes.push(delta >= 0 ? `content (+${delta} chars)` : `content (${delta} chars)`);
  }
  return changes.length ? `Edited ${changes.join(", ")}` : "No content changes";
};

/**
 * Shared edit-mode state for the wiki entity shell.
 * Mirrors OS Robin's "single edit state owner" pattern, adapted for this app.
 */
export function useWikiEntityEditMode({
  infoVisible,
  setInfoVisible,
  serverRevisions,
}: UseWikiEntityEditModeArgs): WikiEntityEditMode {
  const [isEditing, setIsEditing] = useState(false);
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [draftContent, setDraftContentState] = useState("");
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [baselineContent, setBaselineContent] = useState("");
  const [draftTitle, setDraftTitleState] = useState("");
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const [baselineTitle, setBaselineTitle] = useState("");
  const [draftChipLabel, setDraftChipLabelState] = useState("");
  const [savedChipLabel, setSavedChipLabel] = useState<string | null>(null);
  const [baselineChipLabel, setBaselineChipLabel] = useState("");
  const [revisions, setRevisions] = useState<WikiRevision[]>([]);

  const infoVisibleBeforeEditingRef = useRef(true);
  const infoVisibleBeforeHistoryRef = useRef(true);
  const seededRef = useRef(false);
  // Cache the last seen read-mode HTML. When the user goes Read → View history → Edit,
  // the read div has been unmounted by the time Edit fires, so the caller's live
  // `readContentRef.current.innerHTML` is empty. We fall back to this snapshot.
  const lastReadHtmlRef = useRef<string>("");

  // When revisions are seeded from the server they hold contentSnippet values
  // which are BEFORE states. The actual current content (AFTER the latest edit)
  // is only available at interaction time (openHistory / enterEditMode). If the
  // head revision doesn't already reflect the current content, prepend it so
  // the timeline and handleSave diff against the real state instead of an
  // empty/stale BEFORE snapshot.
  const prependCurrentIfNeeded = useCallback(
    (startContent: string, startTitle: string, startChipLabel: string) => {
      if (!seededRef.current) return; // local seedInitialRevision handles this
      if (savedContent !== null) return; // handleSave already manages the head
      if (!startContent) return;
      setRevisions((prev) => {
        if (prev.length === 0 || prev[0].content === startContent) return prev;
        return [
          {
            id: `rev-${generateUlid()}`,
            timestamp: Date.now(),
            title: startTitle,
            chipLabel: startChipLabel,
            content: startContent,
            // This entry represents the live state of the page at the
            // moment history was opened, not a recorded edit event,
            // so the row gets neutral labels instead of inheriting the
            // previous server revision's summary/author.
            summary: "Current state",
            author: "",
          },
          ...prev,
        ];
      });
    },
    [savedContent],
  );

  const seedInitialRevision = useCallback(
    (content: string, title: string, chipLabel: string) => {
      if (content) lastReadHtmlRef.current = content;
      if (seededRef.current) return;
      // Skip seeding a synthetic baseline when there's no real content to
      // diff against. Otherwise the first user save would diff against
      // "" and render the entire article as an additive blob in history.
      // handleSave will create the first revision as "Initial revision"
      // (via diffSummary(null, ...)) and flip seededRef itself.
      if (htmlToPlainText(content).trim() === "") return;
      seededRef.current = true;
      setRevisions([
        {
          id: `rev-${generateUlid()}`,
          timestamp: Date.now(),
          title,
          chipLabel,
          content,
          summary: "Initial revision",
          author: "You",
        },
      ]);
    },
    [],
  );

  // Seed revisions from server data when available and local revisions are empty
  useEffect(() => {
    if (serverRevisions && serverRevisions.length > 0 && revisions.length === 0) {
      setRevisions(serverRevisions);
      seededRef.current = true;
    }
  }, [serverRevisions, revisions.length]);

  const setDraftContent = useCallback((value: string) => {
    setDraftContentState(value);
  }, []);

  const setDraftTitle = useCallback((value: string) => {
    setDraftTitleState(value);
  }, []);

  const setDraftChipLabel = useCallback((value: string) => {
    setDraftChipLabelState(value);
  }, []);

  const enterEditMode = useCallback(
    ({
      currentHtml,
      currentTitle,
      currentChipLabel,
    }: {
      currentHtml: string;
      currentTitle: string;
      currentChipLabel: string;
    }) => {
      const startContent =
        savedContent ?? (currentHtml || lastReadHtmlRef.current);
      const startTitle = savedTitle ?? currentTitle;
      const startChipLabel = savedChipLabel ?? currentChipLabel;
      seedInitialRevision(startContent, startTitle, startChipLabel);
      prependCurrentIfNeeded(startContent, startTitle, startChipLabel);
      infoVisibleBeforeEditingRef.current = infoVisible;
      setBaselineContent(startContent);
      setBaselineTitle(startTitle);
      setBaselineChipLabel(startChipLabel);
      setDraftContentState(startContent);
      setDraftTitleState(startTitle);
      setDraftChipLabelState(startChipLabel);
      setInfoVisible(false);
      setIsViewingHistory(false);
      setIsEditing(true);
    },
    [infoVisible, prependCurrentIfNeeded, savedChipLabel, savedContent, savedTitle, seedInitialRevision, setInfoVisible],
  );

  const openHistory = useCallback(
    ({
      currentHtml,
      currentTitle,
      currentChipLabel,
    }: {
      currentHtml: string;
      currentTitle: string;
      currentChipLabel: string;
    }) => {
      const startContent = savedContent ?? currentHtml;
      const startTitle = savedTitle ?? currentTitle;
      const startChipLabel = savedChipLabel ?? currentChipLabel;
      seedInitialRevision(startContent, startTitle, startChipLabel);
      prependCurrentIfNeeded(startContent, startTitle, startChipLabel);
      infoVisibleBeforeHistoryRef.current = infoVisible;
      setInfoVisible(false);
      setIsEditing(false);
      setIsViewingHistory(true);
    },
    [infoVisible, prependCurrentIfNeeded, savedChipLabel, savedContent, savedTitle, seedInitialRevision, setInfoVisible],
  );

  const closeHistory = useCallback(() => {
    setIsViewingHistory(false);
    setInfoVisible(infoVisibleBeforeHistoryRef.current);
  }, [setInfoVisible]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setInfoVisible(infoVisibleBeforeEditingRef.current);
  }, [setInfoVisible]);

  const handleSave = useCallback(() => {
    setSavedContent(draftContent);
    setSavedTitle(draftTitle);
    setSavedChipLabel(draftChipLabel);
    setBaselineContent(draftContent);
    setBaselineTitle(draftTitle);
    setBaselineChipLabel(draftChipLabel);
    setRevisions((prev) => {
      const last = prev[0] ?? null;
      const next = { title: draftTitle, chipLabel: draftChipLabel, content: draftContent };
      if (
        last &&
        last.title === next.title &&
        last.chipLabel === next.chipLabel &&
        htmlToPlainText(last.content) === htmlToPlainText(next.content)
      ) {
        return prev;
      }
      const revision: WikiRevision = {
        id: `rev-${generateUlid()}`,
        timestamp: Date.now(),
        title: draftTitle,
        chipLabel: draftChipLabel,
        content: draftContent,
        summary: diffSummary(last, next),
        author: "You",
      };
      return [revision, ...prev];
    });
    // Once a real revision exists, lock out further seeding — otherwise a
    // later enterEditMode/openHistory would overwrite the saved history.
    seededRef.current = true;
    exitEditMode();
  }, [draftChipLabel, draftContent, draftTitle, exitEditMode]);

  const handleCancel = useCallback(() => {
    setDraftContentState(baselineContent);
    setDraftTitleState(baselineTitle);
    setDraftChipLabelState(baselineChipLabel);
    exitEditMode();
  }, [baselineChipLabel, baselineContent, baselineTitle, exitEditMode]);

  const isDirty =
    isEditing &&
    (draftContent !== baselineContent ||
      draftTitle !== baselineTitle ||
      draftChipLabel !== baselineChipLabel);

  useEffect(() => {
    if (!isEditing) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        handleCancel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEditing, handleCancel, handleSave]);

  useEffect(() => {
    if (!isEditing || !isDirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isEditing, isDirty]);

  return {
    isEditing,
    isViewingHistory,
    isDirty,
    draftContent,
    savedContent,
    /** Snapshot taken when enterEditMode() ran; drives the diff
     *  preview in WikiEntityArticle so "before" stays the version the
     *  user started editing from, not the most recently saved one. */
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
  };
}

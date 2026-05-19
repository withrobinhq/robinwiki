"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { WikiSettingsPrefill } from "@/lib/wikiSettingsPrefill";
import {
  useWikiTypesList,
  type WikiTypeListItem,
} from "@/hooks/useWikiTypesList";
import { useToggleBouncerMode } from "@/hooks/useToggleBouncerMode";
import { useCollections } from "@/hooks/useCollections";
import { publishWiki, unpublishWiki, updateWiki } from "@/lib/generated";

export type { WikiSettingsPrefill } from "@/lib/wikiSettingsPrefill";

export interface AddWikiModalProps {
  open: boolean;
  onClose: () => void;
  /** Figma 311:5034 — defaults to Create New Wiki */
  title?: string;
  confirmLabel?: string;
  /** When opening from an existing wiki (gear), seed form fields */
  prefill?: WikiSettingsPrefill | null;
  /** Wiki id for settings-mode PUT. 'preview' or undefined → skip network call (prototype pages). */
  wikiId?: string;
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1" />
      <path
        d="M7 5.5v3.5M7 4v.25"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label
      className="text-[12px] font-normal leading-4 tracking-[0.32px]"
      style={{ color: "#545353" }}
    >
      {children}
    </Label>
  );
}


export default function AddWikiModal({
  open,
  onClose,
  title = "Create New Wiki",
  confirmLabel = "Create Wiki",
  prefill = null,
  wikiId,
}: AddWikiModalProps) {
  const wasOpen = useRef(false);
  const [name, setName] = useState("");
  const [wikiType, setWikiType] = useState("");
  const [description, setDescription] = useState("");
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  /**
   * Wiki Style override (#358), persisted to `wikis.prompt`. Swaps the
   * type's `system_message` (LLM persona / tone) at regen time. Empty
   * string === "use the type default".
   */
  const [wikiPrompt, setWikiPrompt] = useState<string>("");
  const [wikiPromptEdited, setWikiPromptEdited] = useState<boolean>(false);
  /**
   * Wiki Format override (#358), persisted to `wikis.structure`.
   * Swaps the type's `default_structure` (document skeleton, used as
   * `{{structure}}` in the wiki-type template) at regen time. Sibling of
   * `wikiPrompt`; same empty-string semantics.
   */
  const [wikiStructure, setWikiStructure] = useState<string>("");
  const [wikiStructureEdited, setWikiStructureEdited] = useState<boolean>(false);
  /** Existing-wiki settings: form read-only until user clicks Edit Wiki */
  const [fieldsEditable, setFieldsEditable] = useState(true);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Saved");
  const saveCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevWikiTypeRef = useRef<string>("");
  const [bouncerMode, setBouncerMode] = useState<"auto" | "review">("auto");
  const initialBouncerModeRef = useRef<"auto" | "review">("auto");
  /** #255: publish toggle state inside settings modal. */
  const [published, setPublished] = useState<boolean>(false);
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null);
  /** Stream I Phase 4: origin recorded at publish time. Drives the
   *  clickable URL when the user is browsing from a different host. */
  const [publishedOrigin, setPublishedOrigin] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  /** Collection membership — settings mode persists immediately via API; create
   *  mode stages locally and applies after POST /wikis returns the new id. */
  const [localCollections, setLocalCollections] = useState<
    Array<{ id: string; name: string; slug: string; color: string }>
  >([]);
  const [collectionPendingId, setCollectionPendingId] = useState<string | null>(null);
  const [collectionError, setCollectionError] = useState<string | null>(null);

  const isSettingsView = Boolean(prefill);

  const queryClient = useQueryClient();
  const toggleBouncer = useToggleBouncerMode();
  const { data: allCollections } = useCollections();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: wikiTypesData, isLoading: typesLoading } = useWikiTypesList();

  // API returns YAML-backed types only; `people` has no YAML on disk.
  const sortedTypes = useMemo<WikiTypeListItem[]>(() => {
    const apiList = wikiTypesData?.wikiTypes ?? [];
    return [...apiList]
      .filter((t) => t.slug !== "people")
      .sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  }, [wikiTypesData?.wikiTypes]);

  // Per-type defaults used as field placeholders so the empty-state of
  // Wiki Format / Wiki Style shows what the override would replace.
  const activeType = useMemo(() => {
    if (!wikiType) return null;
    return sortedTypes.find((t) => t.slug === wikiType) ?? null;
  }, [wikiType, sortedTypes]);
  const activeTypeDefaultStructure = activeType?.defaultStructure ?? "";
  const activeTypeDefaultSystemMessage = activeType?.defaultSystemMessage ?? "";

  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        setShowSavedToast(false);
        setSubmitError(null);
        setSubmitting(false);
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
          saveCloseTimerRef.current = null;
        }
        if (prefill) {
          const nextType = prefill.wikiType ?? "";
          setName(prefill.name ?? "");
          setWikiType(nextType);
          setDescription(prefill.description ?? "");
          setSubtitle(prefill.subtitle);
          setWikiPrompt(prefill.promptOverride ?? "");
          setWikiPromptEdited(
            Boolean(
              prefill.promptOverride && prefill.promptOverride.length > 0,
            ),
          );
          setWikiStructure(prefill.structureOverride ?? "");
          setWikiStructureEdited(
            Boolean(
              prefill.structureOverride && prefill.structureOverride.length > 0,
            ),
          );
          prevWikiTypeRef.current = nextType;
          const bm = prefill.bouncerMode ?? "auto";
          setBouncerMode(bm);
          initialBouncerModeRef.current = bm;
          setPublished(Boolean(prefill.published));
          setPublishedSlug(prefill.publishedSlug ?? null);
          setPublishedOrigin(prefill.publishedOrigin ?? null);
          setPublishError(null);
          setLocalCollections(prefill.collections ?? []);
          setCollectionPendingId(null);
          setCollectionError(null);
          setFieldsEditable(false);
        } else {
          setName("");
          setWikiType("");
          setDescription("");
          setSubtitle(undefined);
          setWikiPrompt("");
          setWikiPromptEdited(false);
          setWikiStructure("");
          setWikiStructureEdited(false);
          prevWikiTypeRef.current = "";
          setBouncerMode("auto");
          initialBouncerModeRef.current = "auto";
          setPublished(false);
          setPublishedSlug(null);
          setPublishError(null);
          setLocalCollections([]);
          setCollectionPendingId(null);
          setCollectionError(null);
          setFieldsEditable(true);
        }
      }
      wasOpen.current = true;
    } else {
      wasOpen.current = false;
    }
  }, [open, prefill]);

  useEffect(() => {
    return () => {
      if (saveCloseTimerRef.current) {
        clearTimeout(saveCloseTimerRef.current);
        saveCloseTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Prompt customization is tied to a specific wiki type. When the type
   * changes, discard any override and reload the new type's default — a
   * "Customized Voice Prompt" wouldn't make sense if the user originally
   * customized the Agent prompt.
   */
  useEffect(() => {
    if (prevWikiTypeRef.current === wikiType) return;
    prevWikiTypeRef.current = wikiType;
    setWikiPromptEdited(false);
    setWikiPrompt("");
  }, [wikiType]);

  const locked = isSettingsView && !fieldsEditable;

  const handleAddToCollection = async (groupId: string) => {
    if (!groupId || collectionPendingId) return;
    if (localCollections.some((c) => c.id === groupId)) return;
    const added = (allCollections ?? []).find((c) => c.id === groupId);
    if (!added) return;
    const entry = { id: added.id, name: added.name, slug: added.slug, color: added.color };

    // Create mode (or prototype sentinel) — stage locally; POST happens after
    // the wiki itself is created in handleConfirm.
    const isSentinel = !wikiId || wikiId === "preview";
    if (isSentinel) {
      setCollectionError(null);
      setLocalCollections((prev) => [...prev, entry]);
      return;
    }

    setCollectionPendingId(groupId);
    setCollectionError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/wikis`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wikiId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setCollectionError(body || `Failed to add to collection (${res.status})`);
        return;
      }
      setLocalCollections((prev) => [...prev, entry]);
      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
      await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
    } catch {
      setCollectionError("Network error. Check your connection and retry.");
    } finally {
      setCollectionPendingId(null);
    }
  };

  const handleRemoveFromCollection = async (groupId: string) => {
    if (collectionPendingId) return;

    const isSentinel = !wikiId || wikiId === "preview";
    if (isSentinel) {
      setCollectionError(null);
      setLocalCollections((prev) => prev.filter((c) => c.id !== groupId));
      return;
    }

    setCollectionPendingId(groupId);
    setCollectionError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/wikis/${wikiId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.text().catch(() => "");
        setCollectionError(body || `Failed to remove from collection (${res.status})`);
        return;
      }
      setLocalCollections((prev) => prev.filter((c) => c.id !== groupId));
      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
      await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
    } catch {
      setCollectionError("Network error. Check your connection and retry.");
    } finally {
      setCollectionPendingId(null);
    }
  };

  const handleConfirm = async () => {
    if (locked) {
      setFieldsEditable(true);
      return;
    }
    if (isSettingsView) {
      const trimmedName = name.trim();
      if (trimmedName.length < 3) {
        setSubmitError("Name must be at least 3 characters.");
        return;
      }
      if (!wikiType) {
        setSubmitError("Pick a wiki type.");
        return;
      }

      // Prototype-page sentinel: skip network call, preserve UX.
      const isSentinel = !wikiId || wikiId === "preview";
      if (isSentinel) {
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
          saveCloseTimerRef.current = null;
        }
        onClose();
        setToastMessage("Saved");
        setShowSavedToast(true);
        saveCloseTimerRef.current = setTimeout(() => {
          setShowSavedToast(false);
          saveCloseTimerRef.current = null;
        }, 2000);
        return;
      }

      setSubmitting(true);
      setSubmitError(null);
      try {
        // Empty string clears the override; non-empty sets it. Never send
        // null because Zod rejects. Wiki Style edits `wikis.prompt`,
        // Wiki Format edits `wikis.structure`. The two are independent
        // overrides and both ride on every save so a cleared field reaches
        // the server as "".
        const payload: {
          name?: string;
          type?: string;
          description?: string;
          prompt: string;
          structure: string;
        } = {
          prompt: wikiPrompt,
          structure: wikiStructure,
        };
        if (prefill && trimmedName !== prefill.name) {
          payload.name = trimmedName;
        }
        if (prefill && wikiType !== prefill.wikiType) {
          payload.type = wikiType;
        }
        if (prefill && description !== prefill.description) {
          payload.description = description;
        }
        const { error } = await updateWiki({
          path: { id: wikiId },
          body: payload,
          credentials: "include",
        });
        if (error) {
          const message =
            (error as { error?: string })?.error ?? "Save failed.";
          setSubmitError(message);
          return;
        }
        // Toggle bouncer mode separately if changed
        if (bouncerMode !== initialBouncerModeRef.current) {
          try {
            await toggleBouncer.mutateAsync({ id: wikiId, mode: bouncerMode });
          } catch {
            // Non-fatal
          }
        }
        await queryClient.invalidateQueries({ queryKey: ["wikis"] });
        await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
        onClose();
        setToastMessage("Saved");
        setShowSavedToast(true);
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
        }
        saveCloseTimerRef.current = setTimeout(() => {
          setShowSavedToast(false);
          saveCloseTimerRef.current = null;
        }, 2000);
      } catch {
        setSubmitError("Network error. Check your connection and retry.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Create mode — hit POST /api/wikis.
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      setSubmitError("Name must be at least 3 characters.");
      return;
    }
    if (!wikiType) {
      setSubmitError("Pick a wiki type.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmedPrompt = wikiPrompt.trim();
      const trimmedStructure = wikiStructure.trim();
      const body = {
        name: trimmedName,
        type: wikiType,
        description: description.trim() || undefined,
        prompt: trimmedPrompt.length > 0 ? trimmedPrompt : undefined,
        structure: trimmedStructure.length > 0 ? trimmedStructure : undefined,
      };
      const res = await fetch("/api/wikis", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Create failed (${res.status})`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          /* ignore JSON parse */
        }
        setSubmitError(message);
        return;
      }

      // Apply staged collection memberships against the new wiki id. Best-effort
      // and parallel: a partial failure does not roll back the wiki create — the
      // user can re-add from settings.
      let createdWikiId: string | undefined;
      try {
        const created = (await res.clone().json()) as { lookupKey?: string };
        createdWikiId = created.lookupKey;
      } catch {
        /* response wasn't JSON — proceed without applying collections */
      }
      let collectionFailures: string[] = [];
      if (createdWikiId && localCollections.length > 0) {
        const results = await Promise.all(
          localCollections.map(async (c) => {
            try {
              const r = await fetch(`/api/groups/${c.id}/wikis`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wikiId: createdWikiId }),
              });
              return r.ok ? null : c.name;
            } catch {
              return c.name;
            }
          }),
        );
        collectionFailures = results.filter((x): x is string => x !== null);
        if (localCollections.length > collectionFailures.length) {
          await queryClient.invalidateQueries({ queryKey: ["collections"] });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
      onClose();
      setToastMessage(
        collectionFailures.length > 0
          ? `Wiki created. Failed to file in ${collectionFailures.length} collection${collectionFailures.length === 1 ? "" : "s"}.`
          : "Wiki created",
      );
      setShowSavedToast(true);
      if (saveCloseTimerRef.current) {
        clearTimeout(saveCloseTimerRef.current);
      }
      saveCloseTimerRef.current = setTimeout(() => {
        setShowSavedToast(false);
        saveCloseTimerRef.current = null;
      }, 2000);
    } catch {
      setSubmitError("Network error. Check your connection and retry.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent
          className="p-0 sm:max-w-[571px] gap-0 rounded-2xl border-black/10 flex flex-col"
          style={{ maxHeight: "min(631px, 90vh)", overflow: "hidden" }}
        >
          <DialogHeader className="px-5 pt-5 pb-2 shrink-0">
            <DialogTitle
              style={{
                ...T.h1,
                color: "#111111",
                fontWeight: 400,
                margin: 0,
              }}
            >
              {title}
            </DialogTitle>
            <DialogDescription
              style={{
                ...T.micro,
                lineHeight: "19px",
                color: "#676d76",
                margin: 0,
              }}
            >
              {subtitle ?? "Create a new wiki to organize your knowledge."}
            </DialogDescription>
          </DialogHeader>

          <div className="h-px w-full bg-[#e5e5e5] shrink-0" />

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto">

          {/* Name */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>Name</FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="E.g The City of Trust"
              disabled={locked}
              className="h-10"
            />
          </div>

          {/* Type */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>
              Type <InfoIcon className="text-[#545353]" />
            </FieldLabel>
            <div className="relative">
              <select
                value={wikiType}
                onChange={(e) => setWikiType(e.target.value)}
                disabled={locked}
                aria-label="Wiki type"
                className="flex h-10 w-full items-center rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none appearance-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                style={{ color: wikiType ? "#111111" : "#a8a8a8" }}
              >
                <option value="">
                  {typesLoading ? "Loading types…" : "Choose a type"}
                </option>
                {sortedTypes.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.displayLabel}
                  </option>
                ))}
              </select>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#a8a8a8]"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {/* Description */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>
              Description <InfoIcon className="text-[#545353]" />
            </FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Countries I have visited. Whether a specific county meets the threshold."
              rows={3}
              disabled={locked}
              className="min-h-[96px] resize-none"
            />
          </div>

          {/* Wiki Format (#358). Binds to wikis.structure, overrides
              the type's default_structure (the {{structure}} block in the
              wiki-type template). Sits next to Description because both
              shape WHAT the wiki contains. Empty value = "use the type
              default"; the Revert button clears the override. */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>
                Wiki Format <InfoIcon className="text-[#545353]" />
              </FieldLabel>
              <button
                type="button"
                onClick={() => {
                  setWikiStructure("");
                  setWikiStructureEdited(false);
                }}
                disabled={locked || !wikiStructureEdited}
                aria-label="Revert Wiki Format to default"
                className="text-[11px] leading-4 underline disabled:opacity-50 disabled:no-underline"
                style={{ color: "var(--wiki-link)", background: "none", border: "none", padding: 0, cursor: locked || !wikiStructureEdited ? "default" : "pointer" }}
              >
                Revert to default
              </button>
            </div>
            <Textarea
              value={wikiStructure || activeTypeDefaultStructure}
              onChange={(e) => {
                const next = e.target.value;
                setWikiStructure(next);
                setWikiStructureEdited(next.trim().length > 0);
              }}
              rows={6}
              disabled={locked || !wikiType}
              className="min-h-[120px] resize-none font-mono"
            />
          </div>

          {/* Collections — visible in both create and settings mode. In create
              mode, selections are staged locally and applied after POST /wikis
              succeeds (see handleConfirm). In settings mode, add/remove fire
              direct API calls immediately. */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>Collections</FieldLabel>
            {localCollections.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {localCollections.map((c) => {
                  const removing = collectionPendingId === c.id;
                  return (
                    <span
                      key={c.id}
                      className="inline-flex items-center gap-1.5 px-2 py-1 text-[12px] border rounded-none"
                      style={{
                        borderColor: "var(--wiki-card-border)",
                        opacity: removing ? 0.5 : 1,
                      }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: c.color || "var(--wiki-count)" }}
                        aria-hidden
                      />
                      <span style={{ color: "var(--wiki-article-text)" }}>{c.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove from ${c.name}`}
                        onClick={() => handleRemoveFromCollection(c.id)}
                        disabled={removing || collectionPendingId !== null}
                        className="ml-1 inline-flex items-center justify-center w-4 h-4 text-[14px] leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ color: "var(--wiki-count)" }}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                Not in any collection.
              </span>
            )}
            {(() => {
              const available = (allCollections ?? []).filter(
                (c) => !localCollections.some((lc) => lc.id === c.id),
              );
              if (available.length === 0) {
                return (
                  <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                    {(allCollections ?? []).length === 0
                      ? "No collections yet — create one from + Add → Collection."
                      : "Already in every collection."}
                  </span>
                );
              }
              return (
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) {
                      void handleAddToCollection(id);
                      e.target.value = "";
                    }
                  }}
                  disabled={collectionPendingId !== null}
                  className="border rounded-none px-2 py-1.5 text-[12px] bg-white"
                  style={{
                    borderColor: "var(--wiki-card-border)",
                    color: "var(--wiki-article-text)",
                  }}
                >
                  <option value="">Add to collection…</option>
                  {available.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              );
            })()}
            {collectionError ? (
              <span
                role="alert"
                className="text-[11px] leading-4"
                style={{ color: "#c0392b" }}
              >
                {collectionError}
              </span>
            ) : null}
          </div>

          {/* Wiki Style (#358). Binds to wikis.prompt, swaps the type's
              system_message at regen time. Sits below Wiki Format
              because tone is a customization on top of the document the
              user just shaped. Empty value = "use the type default";
              the Revert button clears the override. */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>
                Wiki Style <InfoIcon className="text-[#545353]" />
              </FieldLabel>
              <button
                type="button"
                onClick={() => {
                  setWikiPrompt("");
                  setWikiPromptEdited(false);
                }}
                disabled={locked || !wikiPromptEdited}
                aria-label="Revert Wiki Style to default"
                className="text-[11px] leading-4 underline disabled:opacity-50 disabled:no-underline"
                style={{ color: "var(--wiki-link)", background: "none", border: "none", padding: 0, cursor: locked || !wikiPromptEdited ? "default" : "pointer" }}
              >
                Revert to default
              </button>
            </div>
            <Textarea
              value={wikiPrompt || activeTypeDefaultSystemMessage}
              onChange={(e) => {
                const next = e.target.value;
                setWikiPrompt(next);
                setWikiPromptEdited(next.trim().length > 0);
              }}
              rows={6}
              disabled={locked || !wikiType}
              className="min-h-[120px] resize-none font-mono"
            />
          </div>

          {/* Fragment Review Mode toggle -- settings mode only */}
          {isSettingsView && (
            <div className="px-5 pt-4 flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <FieldLabel>Fragment Review Mode</FieldLabel>
                <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                  {bouncerMode === "review"
                    ? "New fragments require manual approval"
                    : "Fragments auto-accepted into this wiki"}
                </span>
              </div>
              <Switch
                checked={bouncerMode === "review"}
                onCheckedChange={(checked: boolean) =>
                  setBouncerMode(checked ? "review" : "auto")
                }
                disabled={locked}
                size="sm"
              />
            </div>
          )}

          {/* #255: Publish/unpublish toggle — settings mode only.
              Calls the existing /wikis/:id/publish + /unpublish endpoints
              eagerly (no save-button gating) so the toggle reflects the
              live published state at all times. */}
          {isSettingsView && wikiId && wikiId !== "preview" && (
            <div className="px-5 pt-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <FieldLabel>Publish</FieldLabel>
                  <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                    {published
                      ? "Public — anyone with the link can read this wiki"
                      : "Private — only you can read this wiki"}
                  </span>
                </div>
                <Switch
                  aria-label="Publish wiki"
                  checked={published}
                  onCheckedChange={async (next: boolean) => {
                    if (publishBusy) return;
                    setPublishBusy(true);
                    setPublishError(null);
                    try {
                      if (next) {
                        const { data, error } = await publishWiki({
                          path: { id: wikiId },
                          credentials: "include",
                        });
                        if (error) throw new Error((error as { error?: string })?.error ?? "Publish failed");
                        setPublished(true);
                        setPublishedSlug(
                          (data as { publishedSlug?: string } | undefined)?.publishedSlug ?? null,
                        );
                        setPublishedOrigin(
                          (data as { publishedOrigin?: string | null } | undefined)?.publishedOrigin ?? null,
                        );
                      } else {
                        const { error } = await unpublishWiki({
                          path: { id: wikiId },
                          credentials: "include",
                        });
                        if (error) throw new Error((error as { error?: string })?.error ?? "Unpublish failed");
                        setPublished(false);
                        setPublishedSlug(null);
                        setPublishedOrigin(null);
                      }
                      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
                      await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
                    } catch (err) {
                      setPublishError(err instanceof Error ? err.message : "Toggle failed");
                    } finally {
                      setPublishBusy(false);
                    }
                  }}
                  disabled={publishBusy}
                  size="sm"
                />
              </div>
              {published && publishedSlug ? (
                <div
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
                  style={{ background: "var(--surface-subtle)", border: "1px solid var(--btn-disabled-bg)" }}
                >
                  <span
                    style={{ ...T.micro, color: "var(--input-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {`/p/${publishedSlug}`}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const base = publishedOrigin || window.location.origin;
                        const url = `${base}/p/${publishedSlug}`;
                        void navigator.clipboard.writeText(url).catch(() => {});
                      }}
                      className="rounded px-2 text-[11px]"
                      style={{ background: "transparent", border: "1px solid var(--btn-disabled-bg)", color: "var(--wiki-link)" }}
                    >
                      Copy link
                    </button>
                    {/*
                      H2: A-game line 441 requires a copy AND open affordance
                      on publish-success. Open opens /p/<slug> in a new tab
                      so the user can verify the published surface without
                      losing their settings-modal context.
                    */}
                    <button
                      type="button"
                      onClick={() => {
                        const base = publishedOrigin || window.location.origin;
                        const url = `${base}/p/${publishedSlug}`;
                        window.open(url, "_blank", "noopener,noreferrer");
                      }}
                      className="rounded px-2 text-[11px]"
                      style={{ background: "transparent", border: "1px solid var(--btn-disabled-bg)", color: "var(--wiki-link)" }}
                    >
                      Open
                    </button>
                  </div>
                </div>
              ) : null}
              {publishError ? (
                <span style={{ ...T.micro, color: "var(--destructive)" }}>{publishError}</span>
              ) : null}
            </div>
          )}

          <div className="pb-5" />

          {submitError ? (
            <div
              role="alert"
              className="px-5 pt-3 text-[13px]"
              style={{ color: "#c0392b" }}
            >
              {submitError}
            </div>
          ) : null}

          </div>
          {/* /Scrollable body */}

          <div className="h-px w-full bg-[#e5e5e5] shrink-0" />

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-5 py-4 shrink-0">
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="rounded-none bg-[var(--wiki-link)] text-white hover:bg-[var(--wiki-link-hover)]"
            >
              {locked
                ? confirmLabel
                : isSettingsView
                  ? submitting
                    ? "Saving…"
                    : "Save"
                  : submitting
                    ? "Creating…"
                    : confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Toast
        message={toastMessage}
        visible={!open && showSavedToast}
        onDismiss={() => setShowSavedToast(false)}
      />
    </>
  );
}

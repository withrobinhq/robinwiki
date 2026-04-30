"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createEntry } from "@/lib/generated";
import { useWikis } from "@/hooks/useWikis";
import { autoDatePrefix } from "@/lib/autoDatePrefix";

export interface AddEntryModalProps {
  open: boolean;
  onClose: () => void;
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

/**
 * #235 — capture mode picker:
 *   "robin"  — default; runs the AI classifier (POST /entries)
 *   "direct" — user picks a target wiki; calls POST /fragments/log
 *              and applies the YYMMDD auto-date-prefix on short bodies.
 */
type CaptureMode = "robin" | "direct";

export default function AddEntryModal({ open, onClose }: AddEntryModalProps) {
  const wasOpen = useRef(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Entry created");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mode, setMode] = useState<CaptureMode>("robin");
  const [targetSlug, setTargetSlug] = useState<string>("");

  const queryClient = useQueryClient();
  const { data: wikisData } = useWikis();
  const wikiOptions = useMemo(() => {
    const list = wikisData?.wikis ?? [];
    return [...list]
      .filter((w) => w.slug && w.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [wikisData]);

  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        setTitle("");
        setContent("");
        setSubmitError(null);
        setSubmitting(false);
        setShowToast(false);
        setMode("robin");
        setTargetSlug("");
      }
      wasOpen.current = true;
    } else {
      wasOpen.current = false;
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const handleSubmit = async () => {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      setSubmitError("Content is required.");
      return;
    }

    if (mode === "direct" && !targetSlug) {
      setSubmitError("Pick a target wiki to send directly.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      if (mode === "robin") {
        const { data, error } = await createEntry({
          body: {
            content: trimmedContent,
            title: title.trim() || undefined,
            source: "web",
            type: "thought",
          },
          credentials: "include",
        });
        if (error) {
          const message =
            (error as { error?: string })?.error ?? "Failed to create entry.";
          setSubmitError(message);
          return;
        }
        // Reference the resolved data so unused-var lint stays quiet.
        void data;
        await queryClient.invalidateQueries({ queryKey: ["entries"] });
        setToastMessage("Entry created");
      } else {
        // Direct send — POST /fragments/log with auto-date-prefix on short bodies.
        const finalContent = autoDatePrefix(trimmedContent);
        const res = await fetch("/api/fragments/log", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: finalContent,
            threadSlug: targetSlug,
            title: title.trim() || undefined,
          }),
        });
        if (!res.ok) {
          let msg = `Send failed (${res.status})`;
          try {
            const j = (await res.json()) as { error?: string };
            if (j?.error) msg = j.error;
          } catch {
            /* ignore */
          }
          setSubmitError(msg);
          return;
        }
        await queryClient.invalidateQueries({ queryKey: ["wikis"] });
        await queryClient.invalidateQueries({ queryKey: ["fragments"] });
        setToastMessage("Sent to wiki");
      }

      onClose();
      setShowToast(true);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        setShowToast(false);
        toastTimerRef.current = null;
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
          className="flex flex-col gap-0 rounded-2xl border-black/10 p-0 sm:max-w-[571px]"
          style={{ maxHeight: "min(620px, 90vh)", overflow: "hidden" }}
        >
          <DialogHeader className="shrink-0 px-5 pb-2 pt-5">
            <DialogTitle
              style={{
                ...T.h1,
                color: "#111111",
                fontWeight: 400,
                margin: 0,
              }}
            >
              Add Entry
            </DialogTitle>
            <DialogDescription
              style={{
                ...T.micro,
                lineHeight: "19px",
                color: "#676d76",
                margin: 0,
              }}
            >
              Capture a thought, note, or idea. Robin can file it, or send it
              directly to a wiki you choose.
            </DialogDescription>
          </DialogHeader>

          <div className="h-px w-full shrink-0 bg-[#e5e5e5]" />

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Capture mode picker (#235) */}
            <fieldset className="px-5 pt-4 flex flex-col gap-2 border-0">
              <FieldLabel>Where should this go?</FieldLabel>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="capture-mode"
                    value="robin"
                    checked={mode === "robin"}
                    onChange={() => setMode("robin")}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ ...T.bodySmall }}>
                    <span style={{ fontWeight: 600 }}>Robin files it</span>
                    <span style={{ ...T.micro, color: "#676d76", display: "block" }}>
                      Default. Robin classifies the thought and slots it into the
                      best-fit wiki.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="capture-mode"
                    value="direct"
                    checked={mode === "direct"}
                    onChange={() => setMode("direct")}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ ...T.bodySmall }}>
                    <span style={{ fontWeight: 600 }}>Send directly to a wiki</span>
                    <span style={{ ...T.micro, color: "#676d76", display: "block" }}>
                      Skip the classifier. Short captures get an auto-date prefix
                      so chronological wikis can render the line.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            {mode === "direct" && (
              <div className="flex flex-col gap-2 px-5 pt-4">
                <FieldLabel>Target wiki</FieldLabel>
                <select
                  value={targetSlug}
                  onChange={(e) => setTargetSlug(e.target.value)}
                  aria-label="Target wiki"
                  className="flex h-10 w-full items-center rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">
                    {wikiOptions.length === 0 ? "Loading wikis…" : "Choose a wiki…"}
                  </option>
                  {wikiOptions.map((w) => (
                    <option key={w.id ?? w.slug} value={w.slug}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Title (optional)</FieldLabel>
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Give your thought a title"
                className="h-10"
              />
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Content</FieldLabel>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What's on your mind?"
                rows={6}
                className="min-h-[144px] resize-none"
              />
            </div>

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

          <div className="h-px w-full shrink-0 bg-[#e5e5e5]" />

          <div className="flex shrink-0 items-center justify-end gap-3 px-5 py-4">
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="rounded-none bg-[var(--wiki-link)] text-white hover:bg-[var(--wiki-link-hover)]"
            >
              {submitting
                ? "Adding..."
                : mode === "direct"
                  ? "Send to wiki"
                  : "Add Entry"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Toast
        message={toastMessage}
        visible={!open && showToast}
        onDismiss={() => setShowToast(false)}
      />
    </>
  );
}

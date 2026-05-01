"use client";

import { useState, useRef, useEffect } from "react";
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

export interface AddCollectionModalProps {
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
 * Slug derivation for collection names. Mirrors common kebab-case rules:
 * lowercase, ASCII-strip, collapse non-alphanumerics into single hyphens,
 * trim hyphens from edges. Server-side validation (createGroupBodySchema)
 * only requires non-empty; uniqueness is enforced via UNIQUE on groups.slug.
 */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const COLOR_PALETTE: { value: string; label: string }[] = [
  { value: "#6b7280", label: "Gray" },
  { value: "#2563eb", label: "Blue" },
  { value: "#16a34a", label: "Green" },
  { value: "#9333ea", label: "Purple" },
  { value: "#d97706", label: "Amber" },
  { value: "#dc2626", label: "Red" },
];

export default function AddCollectionModal({ open, onClose }: AddCollectionModalProps) {
  const wasOpen = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(COLOR_PALETTE[0].value);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Collection created");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        setName("");
        setDescription("");
        setColor(COLOR_PALETTE[0].value);
        setSubmitError(null);
        setSubmitting(false);
        setShowToast(false);
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
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSubmitError("Name is required.");
      return;
    }
    const slug = slugifyName(trimmedName);
    if (!slug) {
      setSubmitError("Name must contain at least one letter or number.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      // Groups routes have no SDK binding — use plain fetch (mirrors useCollections).
      const res = await fetch("/api/groups", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          slug,
          color,
          description: description.trim(),
          icon: "",
        }),
      });

      if (!res.ok) {
        let message = `Create failed (${res.status})`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed?.error) {
            message =
              res.status === 409
                ? `A collection with the slug "${slug}" already exists. Try a different name.`
                : parsed.error;
          }
        } catch {
          /* ignore JSON parse */
        }
        setSubmitError(message);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["collections"] });
      onClose();
      setToastMessage("Collection created");
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
          style={{ maxHeight: "min(500px, 90vh)", overflow: "hidden" }}
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
              Add Collection
            </DialogTitle>
            <DialogDescription
              style={{
                ...T.micro,
                lineHeight: "19px",
                color: "#676d76",
                margin: 0,
              }}
            >
              A bucket for grouping wikis. Use it once your knowledge base
              outgrows a single sidebar list.
            </DialogDescription>
          </DialogHeader>

          <div className="h-px w-full shrink-0 bg-[#e5e5e5]" />

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Name</FieldLabel>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Family, Work, Personal"
                className="h-10"
              />
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Color</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {COLOR_PALETTE.map((swatch) => {
                  const selected = color === swatch.value;
                  return (
                    <button
                      key={swatch.value}
                      type="button"
                      aria-label={swatch.label}
                      onClick={() => setColor(swatch.value)}
                      className="inline-flex items-center justify-center"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        backgroundColor: swatch.value,
                        border: selected
                          ? "2px solid var(--wiki-article-text)"
                          : "1px solid var(--wiki-card-border)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Description (optional)</FieldLabel>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What kind of wikis belong in this collection?"
                rows={3}
                className="min-h-[80px] resize-none"
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
              {submitting ? "Creating..." : "Add Collection"}
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

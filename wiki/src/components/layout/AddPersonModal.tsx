"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toast } from "@/components/ui/toast";

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

export interface AddPersonModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * #234 — manual Add Person modal.
 *
 * Bypasses AI extraction. Wires `POST /people` directly so users can seed
 * canonical anchors before the matcher sees the name in any fragment.
 */
export default function AddPersonModal({ open, onClose }: AddPersonModalProps) {
  const wasOpen = useRef(false);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState("");
  const [relationship, setRelationship] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        setName("");
        setAliases([]);
        setAliasInput("");
        setRelationship("");
        setSubmitError(null);
      }
      wasOpen.current = true;
    } else {
      wasOpen.current = false;
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  function addAlias(value: string) {
    const trimmed = value.trim();
    if (trimmed && !aliases.includes(trimmed)) {
      setAliases((prev) => [...prev, trimmed]);
    }
    setAliasInput("");
  }

  function removeAlias(alias: string) {
    setAliases((prev) => prev.filter((a) => a !== alias));
  }

  function handleAliasKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addAlias(aliasInput);
    }
    if (e.key === "Backspace" && aliasInput === "" && aliases.length > 0) {
      setAliases((prev) => prev.slice(0, -1));
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/people", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          aliases: aliases.filter((a) => a.trim().length > 0),
          relationship: relationship.trim(),
        }),
      });
      if (!res.ok) {
        let msg = `Create failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* ignore parse */
        }
        throw new Error(msg);
      }
      return (await res.json()) as { id?: string; lookupKey?: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      onClose();
      setShowToast(true);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setShowToast(false), 2000);
    },
    onError: (err) => {
      setSubmitError(err instanceof Error ? err.message : "Create failed");
    },
  });

  const handleSubmit = () => {
    setSubmitError(null);
    if (!name.trim()) {
      setSubmitError("Name is required.");
      return;
    }
    mutation.mutate();
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
          className="flex flex-col gap-0 rounded-2xl border-black/10 p-0 sm:max-w-[520px]"
          style={{ maxHeight: "min(560px, 90vh)", overflow: "hidden" }}
        >
          <DialogHeader className="shrink-0 px-5 pb-2 pt-5">
            <DialogTitle
              style={{ ...T.h1, color: "#111111", fontWeight: 400, margin: 0 }}
            >
              Add Person
            </DialogTitle>
            <DialogDescription
              style={{ ...T.micro, lineHeight: "19px", color: "#676d76", margin: 0 }}
            >
              Create a canonical person row. Bypasses AI extraction; you can
              edit aliases or merge later.
            </DialogDescription>
          </DialogHeader>

          <div className="h-px w-full shrink-0 bg-[#e5e5e5]" />

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Name</FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                className="h-10"
              />
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Aliases</FieldLabel>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  padding: "6px 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  minHeight: 38,
                  alignItems: "center",
                }}
              >
                {aliases.map((alias) => (
                  <Badge
                    key={alias}
                    variant="secondary"
                    className="flex items-center gap-1 rounded-sm"
                    style={{ padding: "2px 6px", ...T.micro }}
                  >
                    {alias}
                    <button
                      type="button"
                      onClick={() => removeAlias(alias)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                      }}
                      aria-label={`Remove ${alias}`}
                    >
                      <X size={12} />
                    </button>
                  </Badge>
                ))}
                <input
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={handleAliasKeyDown}
                  onBlur={() => aliasInput.trim() && addAlias(aliasInput)}
                  placeholder={aliases.length === 0 ? "Type and press Enter" : ""}
                  style={{
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    flex: 1,
                    minWidth: 80,
                    ...T.micro,
                  }}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <FieldLabel>Relationship (optional)</FieldLabel>
              <Input
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
                placeholder="e.g. Colleague, Friend, Family"
                className="h-10"
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
              disabled={mutation.isPending}
              className="rounded-none bg-[var(--wiki-link)] text-white hover:bg-[var(--wiki-link-hover)]"
            >
              {mutation.isPending ? "Creating..." : "Add Person"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Toast
        message="Person added"
        visible={!open && showToast}
        onDismiss={() => setShowToast(false)}
      />
    </>
  );
}

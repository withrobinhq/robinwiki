"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
import { updatePerson, listPeople } from "@/lib/api";

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

export interface PersonSettingsModalProps {
  open: boolean;
  onClose: () => void;
  personId: string;
  prefill: {
    name: string;
    aliases: string[];
    relationship: string;
  };
}

export default function PersonSettingsModal({
  open,
  onClose,
  personId,
  prefill,
}: PersonSettingsModalProps) {
  const [name, setName] = useState(prefill.name);
  const [aliases, setAliases] = useState<string[]>(prefill.aliases);
  const [aliasInput, setAliasInput] = useState("");
  const [relationship, setRelationship] = useState(prefill.relationship);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setName(prefill.name);
      setAliases(prefill.aliases);
      setRelationship(prefill.relationship);
      setAliasInput("");
      setConfirmDelete(false);
      setMergePickerOpen(false);
      setMergeTargetId("");
      setActionError(null);
    }
  }, [open, prefill.name, prefill.aliases, prefill.relationship]);

  const mutation = useMutation({
    mutationFn: async () => {
      await updatePerson({
        path: { id: personId },
        body: { name, aliases, relationship },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["person", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      onClose();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/people/${personId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      onClose();
      router.push("/wiki");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async (targetPersonId: string) => {
      const res = await fetch(`/api/people/${personId}/merge`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPersonId }),
      });
      if (!res.ok) {
        let msg = `Merge failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      queryClient.invalidateQueries({ queryKey: ["wikis"] });
      onClose();
      router.push("/wiki");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Merge failed");
    },
  });

  const peopleQuery = useMutation({
    mutationFn: async () => {
      const { data } = await listPeople({ query: { limit: 200 } });
      return (data?.people ?? []).filter(
        (p) => (p.id ?? p.lookupKey) !== personId,
      );
    },
  });

  const peopleList = peopleQuery.data ?? [];
  const sortedPeople = useMemo(
    () =>
      [...peopleList].sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? ""),
      ),
    [peopleList],
  );

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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 20 }}
      >
        <DialogHeader>
          <DialogTitle style={T.h2}>Person Settings</DialogTitle>
          <DialogDescription style={{ ...T.micro, color: "#545353" }}>
            Edit the canonical name, aliases, and relationship for this person.
          </DialogDescription>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <FieldLabel>Canonical Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <FieldLabel>Relationship</FieldLabel>
            <Input
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="e.g. Colleague, Friend, Family"
            />
          </div>
        </div>

        {/* Dedup actions: Merge + Delete */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            paddingTop: 8,
            borderTop: "1px solid var(--border)",
          }}
        >
          <FieldLabel>Dedup</FieldLabel>

          {!mergePickerOpen ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActionError(null);
                  setMergePickerOpen(true);
                  if (peopleList.length === 0) peopleQuery.mutate();
                }}
              >
                Merge into…
              </Button>
              {!confirmDelete ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setActionError(null);
                    setConfirmDelete(true);
                  }}
                  style={{ color: "var(--destructive)", borderColor: "var(--destructive)" }}
                >
                  Delete
                </Button>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ ...T.micro, color: "var(--destructive)" }}>
                    Delete this person?
                  </span>
                  <Button
                    type="button"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                    style={{ background: "var(--destructive)", color: "#fff" }}
                  >
                    {deleteMutation.isPending ? "Deleting..." : "Confirm Delete"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ ...T.micro, color: "#545353" }}>
                Pick the person to merge into. The current person will be
                soft-deleted; their aliases and edges follow the target.
              </span>
              <select
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
                aria-label="Merge target person"
                style={{
                  height: 38,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "0 8px",
                  background: "transparent",
                  ...T.bodySmall,
                }}
              >
                <option value="">
                  {peopleQuery.isPending
                    ? "Loading people…"
                    : sortedPeople.length === 0
                      ? "No other people to merge into"
                      : "Choose target…"}
                </option>
                {sortedPeople.map((p) => (
                  <option key={p.id ?? p.lookupKey} value={p.id ?? p.lookupKey}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  type="button"
                  onClick={() => mergeMutation.mutate(mergeTargetId)}
                  disabled={!mergeTargetId || mergeMutation.isPending}
                >
                  {mergeMutation.isPending ? "Merging…" : "Merge"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setMergePickerOpen(false);
                    setMergeTargetId("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {actionError ? (
            <span style={{ ...T.micro, color: "var(--destructive)" }}>
              {actionError}
            </span>
          ) : null}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8 }}>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim()}
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

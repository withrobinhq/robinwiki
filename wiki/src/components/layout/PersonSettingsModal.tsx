"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
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
import { updatePerson } from "@/lib/api";

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
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setName(prefill.name);
      setAliases(prefill.aliases);
      setRelationship(prefill.relationship);
      setAliasInput("");
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
        style={{ maxWidth: 480, display: "flex", flexDirection: "column", gap: 20 }}
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

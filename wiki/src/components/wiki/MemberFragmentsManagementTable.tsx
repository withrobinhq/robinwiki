"use client";

import { useState } from "react";
import Link from "next/link";
import { Unlink } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { ROUTES } from "@/lib/routes";
import { useDetachFragment } from "@/hooks/useDetachFragment";
import ConfirmDialog from "@/components/prompts/ConfirmDialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

export interface MemberFragment {
  id: string;
  slug: string;
  title: string;
  snippet: string;
  edgeStatus?: "active" | "pending";
  createdAt?: string;
}

interface MemberFragmentsManagementTableProps {
  wikiId: string;
  fragments: MemberFragment[];
}

export function MemberFragmentsManagementTable({
  wikiId,
  fragments,
}: MemberFragmentsManagementTableProps) {
  const detach = useDetachFragment();
  const [confirmTarget, setConfirmTarget] = useState<MemberFragment | null>(null);

  if (fragments.length === 0) {
    return (
      <p
        style={{
          ...T.bodySmall,
          color: "var(--wiki-article-text)",
          opacity: 0.6,
          fontStyle: "italic",
          padding: "12px 0",
        }}
      >
        No fragments attached to this wiki yet.
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              style={{ ...T.micro, fontWeight: 600, fontFamily: FONT.SANS }}
            >
              Fragment
            </TableHead>
            <TableHead
              style={{ ...T.micro, fontWeight: 600, fontFamily: FONT.SANS }}
            >
              Status
            </TableHead>
            <TableHead
              style={{ ...T.micro, fontWeight: 600, fontFamily: FONT.SANS }}
              className="text-right"
            >
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fragments.map((frag) => (
            <TableRow key={frag.id}>
              <TableCell>
                <Link
                  href={ROUTES.fragment(frag.id)}
                  style={{
                    ...T.bodySmall,
                    color: "var(--wiki-fragment-link)",
                    textDecoration: "underline",
                    textDecorationSkipInk: "none",
                  }}
                >
                  {frag.title}
                </Link>
                {frag.snippet && (
                  <p
                    style={{
                      ...T.micro,
                      color: "var(--wiki-article-text)",
                      opacity: 0.6,
                      margin: "2px 0 0 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 400,
                    }}
                  >
                    {frag.snippet}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <span
                  style={{
                    ...T.micro,
                    color:
                      frag.edgeStatus === "pending"
                        ? "var(--wiki-count)"
                        : "var(--wiki-article-text)",
                    fontStyle:
                      frag.edgeStatus === "pending" ? "italic" : "normal",
                  }}
                >
                  {frag.edgeStatus === "pending" ? "pending" : "active"}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <button
                  type="button"
                  title="Un-attach fragment"
                  onClick={() => setConfirmTarget(frag)}
                  disabled={detach.isPending}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    fontSize: 12,
                    color: "var(--wiki-article-text)",
                    background: "none",
                    border: "1px solid var(--wiki-card-border)",
                    cursor: detach.isPending ? "default" : "pointer",
                    opacity: detach.isPending ? 0.5 : 1,
                  }}
                >
                  <Unlink size={12} strokeWidth={1.5} />
                  Un-attach
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title="Un-attach fragment"
        description={
          confirmTarget
            ? `Remove "${confirmTarget.title}" from this wiki? The fragment itself will not be deleted.`
            : ""
        }
        confirmLabel="Un-attach"
        destructive
        onConfirm={() => {
          if (confirmTarget) {
            detach.mutate({
              wikiId,
              fragmentId: confirmTarget.id,
            });
          }
        }}
      />
    </>
  );
}

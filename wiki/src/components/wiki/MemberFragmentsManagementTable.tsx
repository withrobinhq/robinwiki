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
  /**
   * When true, the Actions column (with the Un-attach button) is shown.
   * When false, the table is read-only and the Actions column is hidden
   * entirely so the row chrome doesn't suggest an interactive surface.
   */
  manageMode?: boolean;
  /**
   * Set of fragment IDs that appear as citations in the current wiki
   * body. Drives the "cited" / "uncited" label in the Status column.
   * The prior label was always "active", which carries no information
   * since every row in this table is by definition an attached
   * (active-edge) fragment.
   */
  citedFragmentIds?: Set<string>;
}

export function MemberFragmentsManagementTable({
  wikiId,
  fragments,
  manageMode = false,
  citedFragmentIds,
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
            {manageMode && (
              <TableHead
                style={{ ...T.micro, fontWeight: 600, fontFamily: FONT.SANS }}
                className="text-right"
              >
                Actions
              </TableHead>
            )}
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
                {(() => {
                  // "pending" beats cited/uncited because the edge isn't
                  // even active yet, so citation status would be misleading.
                  if (frag.edgeStatus === "pending") {
                    return (
                      <span
                        style={{
                          ...T.micro,
                          color: "var(--wiki-count)",
                          fontStyle: "italic",
                        }}
                      >
                        pending
                      </span>
                    );
                  }
                  const cited = citedFragmentIds?.has(frag.id) ?? false;
                  return (
                    <span
                      style={{
                        ...T.micro,
                        color: cited
                          ? "var(--wiki-article-text)"
                          : "var(--wiki-count)",
                      }}
                    >
                      {cited ? "cited" : "uncited"}
                    </span>
                  );
                })()}
              </TableCell>
              {manageMode && (
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
              )}
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

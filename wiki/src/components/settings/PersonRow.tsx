"use client";

import { Check, X } from "lucide-react";
import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  type PendingPerson,
  useApprovePerson,
  useRejectPerson,
} from "@/hooks/usePendingPersons";

// Stream U: one row per pending person in the People panel.
//
// Approve calls POST /admin/people/:key/approve which flips the row to
// status='verified'. Reject calls POST /admin/people/:key/reject which
// soft-deletes by default; hard delete is gated behind a confirm modal
// (out of this iteration's scope; the hardDelete flag is wired but
// always passed as false from the row).

interface Props {
  person: PendingPerson;
  onSettled?: () => void;
}

export function PersonRow({ person, onSettled }: Props) {
  const approve = useApprovePerson();
  const reject = useRejectPerson();

  const handleApprove = () => {
    approve.mutate(person.lookupKey, { onSettled });
  };
  const handleReject = () => {
    reject.mutate({ personKey: person.lookupKey }, { onSettled });
  };

  const firstSeen = formatTimeAgo(person.createdAt);

  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.4fr) auto auto auto",
        gap: 16,
        alignItems: "center",
        padding: "14px 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ ...T.body, fontWeight: 500, margin: 0 }}>{person.name}</p>
        {person.aliases && person.aliases.length > 0 ? (
          <p
            style={{
              ...T.micro,
              color: "var(--heading-secondary)",
              margin: 0,
              marginTop: 2,
            }}
          >
            also: {person.aliases.join(", ")}
          </p>
        ) : null}
      </div>

      <div style={{ minWidth: 0 }}>
        {person.extractedFromFragmentSnippet ? (
          <p
            style={{
              ...T.micro,
              color: "var(--heading-secondary)",
              margin: 0,
              fontStyle: "italic",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={person.extractedFromFragmentSnippet}
          >
            "{person.extractedFromFragmentSnippet}"
          </p>
        ) : (
          <p style={{ ...T.micro, color: "var(--heading-secondary)", margin: 0 }}>
            (source fragment not available)
          </p>
        )}
      </div>

      <span style={{ ...T.micro, color: "var(--heading-secondary)" }}>
        {person.mentionCount ?? 1} mention{(person.mentionCount ?? 1) === 1 ? "" : "s"}
      </span>

      <span style={{ ...T.micro, color: "var(--heading-secondary)" }}>
        {firstSeen}
      </span>

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          size="sm"
          variant="default"
          disabled={approve.isPending || reject.isPending}
          onClick={handleApprove}
          aria-label={`Approve ${person.name}`}
        >
          {approve.isPending ? <Spinner className="size-3" /> : <Check className="size-3" />}
          approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={approve.isPending || reject.isPending}
          onClick={handleReject}
          aria-label={`Reject ${person.name}`}
        >
          {reject.isPending ? <Spinner className="size-3" /> : <X className="size-3" />}
          reject
        </Button>
      </div>
    </li>
  );
}

function formatTimeAgo(input: string): string {
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

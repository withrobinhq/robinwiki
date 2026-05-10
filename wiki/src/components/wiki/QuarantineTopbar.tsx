"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ShieldAlert, Check, X } from "lucide-react";
import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useApprovePerson,
  useRejectPerson,
} from "@/hooks/usePendingPersons";

export const QUARANTINE_SLOT_ID = "quarantine-banner-root";

interface Props {
  personKey: string;
  personName: string;
}

export function QuarantineTopbar({ personKey, personName }: Props) {
  const router = useRouter();
  const approve = useApprovePerson();
  const reject = useRejectPerson();
  const busy = approve.isPending || reject.isPending;
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(QUARANTINE_SLOT_ID));
  }, []);

  const handleApprove = () => {
    approve.mutate(personKey, {
      onSuccess: () => router.push("/settings/people"),
    });
  };
  const handleReject = () => {
    reject.mutate(
      { personKey },
      { onSuccess: () => router.push("/settings/people") },
    );
  };

  const banner = (
    <div
      role="alert"
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 20px",
        background: "var(--warning-bg, #fef3c7)",
        color: "var(--warning-fg, #78350f)",
        borderBottom: "1px solid var(--warning-border, #f59e0b)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <ShieldAlert className="size-5 shrink-0" strokeWidth={1.5} aria-hidden />
        <p style={{ ...T.bodySmall, margin: 0, lineHeight: 1.4 }}>
          <strong>{personName}</strong> is in quarantine. The system has not
          fully involved them in retrieval, classification, or wiki
          generation yet.
        </p>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          size="sm"
          variant="default"
          onClick={handleApprove}
          disabled={busy}
          aria-label={`Approve ${personName}`}
        >
          {approve.isPending ? <Spinner className="size-3" /> : <Check className="size-3" />}
          approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleReject}
          disabled={busy}
          aria-label={`Reject ${personName}`}
        >
          {reject.isPending ? <Spinner className="size-3" /> : <X className="size-3" />}
          reject
        </Button>
      </div>
    </div>
  );

  if (slot) return createPortal(banner, slot);
  return banner;
}

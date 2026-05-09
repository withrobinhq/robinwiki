"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Toast } from "@/components/ui/toast";
import {
  useBackfillAudit,
  useBackfillRuns,
  useTriggerWikiAgentSchemaBackfill,
} from "@/hooks/useBackfillAudit";

// Stream U: Backfill panel content.
//
// Shows the gap report from /admin/backfill/audit (missing description
// rows, missing hyde rows) and the last-run telemetry from
// /admin/backfill/runs. The "Run backfill" button hits POST
// /admin/backfill/wiki-agent-schema; the audit refetches on success so
// the gap counts update live.
//
// The HyDE pass deliberately does not have a separate trigger here —
// the route runs the description pass only and the periodic heal worker
// picks up HyDE incrementally on its 15-minute tick. Surfacing the gap
// is honest about that split: operators see what is outstanding even
// when only one of the two kinds is triggerable on demand.

export function BackfillPanel() {
  const audit = useBackfillAudit();
  const runs = useBackfillRuns();
  const trigger = useTriggerWikiAgentSchemaBackfill();
  const [toast, setToast] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: "",
  });

  const handleRun = () => {
    trigger.mutate(
      {},
      {
        onSuccess: (data) => {
          if (!data) {
            setToast({ visible: true, message: "Backfill enqueued." });
            return;
          }
          setToast({
            visible: true,
            message: `Backfill done: ${data.ok} written, ${data.failed} failed (${data.scanned} scanned).`,
          });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Backfill failed";
          setToast({ visible: true, message: msg });
        },
      },
    );
  };

  const missingDesc = audit.data?.wikiAgentSchema.missingDescription ?? [];
  const missingHyde = audit.data?.wikiAgentSchema.missingHyde ?? [];
  const lastAuditAt = audit.data?.lastAuditAt;

  return (
    <>
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <div>
              <p style={{ ...T.body, fontWeight: 500, margin: 0 }}>
                wiki_agent_schema description rows
              </p>
              <p
                style={{
                  ...T.micro,
                  color: "var(--heading-secondary)",
                  margin: 0,
                  marginTop: 4,
                }}
              >
                Direct embedding of wikis.description. The runner uses one
                embedding call per wiki; cheap to run on demand.
              </p>
            </div>
            <Button
              size="sm"
              variant={missingDesc.length > 0 ? "default" : "outline"}
              onClick={handleRun}
              disabled={trigger.isPending}
              aria-label="Run backfill for missing description rows"
            >
              {trigger.isPending ? (
                <Spinner className="size-3" />
              ) : (
                <RefreshCw className="size-3" strokeWidth={1.5} />
              )}
              Run backfill
            </Button>
          </div>
          <p
            style={{
              ...T.bodySmall,
              color:
                missingDesc.length > 0
                  ? "var(--warning, #b45309)"
                  : "var(--heading-secondary)",
              marginTop: 12,
              marginBottom: 0,
            }}
          >
            {audit.isLoading
              ? "Loading…"
              : missingDesc.length > 0
                ? `${missingDesc.length} wiki${missingDesc.length === 1 ? "" : "s"} missing description.`
                : "All wikis have description rows."}
          </p>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 16,
          }}
        >
          <p style={{ ...T.body, fontWeight: 500, margin: 0 }}>
            wiki_agent_schema hyde_synthetic rows
          </p>
          <p
            style={{
              ...T.micro,
              color: "var(--heading-secondary)",
              margin: 0,
              marginTop: 4,
            }}
          >
            LLM-generated hypothetical document, then embedded. The heal
            worker picks these up incrementally on a 15-minute cron tick;
            on-demand HyDE bulk runs are intentionally not exposed.
          </p>
          <p
            style={{
              ...T.bodySmall,
              color:
                missingHyde.length > 0
                  ? "var(--warning, #b45309)"
                  : "var(--heading-secondary)",
              marginTop: 12,
              marginBottom: 0,
            }}
          >
            {audit.isLoading
              ? "Loading…"
              : missingHyde.length > 0
                ? `${missingHyde.length} wiki${missingHyde.length === 1 ? "" : "s"} missing hyde_synthetic.`
                : "All wikis have hyde_synthetic rows."}
          </p>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 16,
          }}
        >
          <p style={{ ...T.body, fontWeight: 500, margin: 0 }}>Recent runs</p>
          {runs.isLoading ? (
            <Spinner className="size-4 mt-2" />
          ) : !runs.data?.runs?.length ? (
            <p
              style={{
                ...T.micro,
                color: "var(--heading-secondary)",
                marginTop: 8,
                marginBottom: 0,
              }}
            >
              No backfill jobs have run yet.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                marginTop: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {runs.data.runs.map((run) => (
                <li
                  key={`${run.jobName}-${run.lastRunAt}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 12,
                  }}
                >
                  <span style={{ ...T.bodySmall, color: "var(--heading-color)" }}>
                    {run.jobName}
                  </span>
                  <span
                    style={{
                      ...T.micro,
                      color: "var(--heading-secondary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {run.lastRunStatus} ·{" "}
                    {new Date(run.lastRunAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {lastAuditAt ? (
            <p
              style={{
                ...T.micro,
                color: "var(--heading-secondary)",
                marginTop: 12,
                marginBottom: 0,
              }}
            >
              Last audit: {new Date(lastAuditAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      </section>

      <Toast
        message={toast.message}
        visible={toast.visible}
        onDismiss={() => setToast({ visible: false, message: "" })}
      />
    </>
  );
}

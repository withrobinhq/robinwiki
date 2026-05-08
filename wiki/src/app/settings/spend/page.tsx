"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AuthGuard } from "@/components/AuthGuard";

// ── Types ────────────────────────────────────────────────────────────────
//
// Mirrors GET /settings/spend in core/src/routes/settings.ts. Kept inline
// rather than threaded through the generated SDK because the openapi
// manifest regen lives in a separate phase and we do not want to
// regenerate the whole SDK for one new endpoint.

interface SpendStageRollup {
  stage: string;
  costUsdMicros: number;
  totalTokens: number;
  eventCount: number;
}

interface SpendBudget {
  limitUsdMicros: number;
}

interface SpendResponse {
  rangeStart: string;
  rangeEnd: string;
  totalCostUsdMicros: number;
  totalTokens: number;
  byStage: SpendStageRollup[];
  budgets: {
    regen: SpendBudget;
    embed: SpendBudget;
    classify: SpendBudget;
  };
  outstanding: {
    fragmentRelationshipBackfillQueueDepth: number | null;
    lastCronRunAt: string | null;
  };
}

const STAGE_LABELS: Record<string, string> = {
  capture: "Capture",
  fragment: "Fragmentation",
  classify: "Classification",
  regen: "Regeneration",
  embed: "Embedding",
  search: "Search",
};

const STAGE_ORDER = ["capture", "fragment", "classify", "regen", "embed", "search"];

const BUDGET_KINDS: Array<{
  key: "regen" | "embed" | "classify";
  label: string;
  description: string;
}> = [
  {
    key: "regen",
    label: "Regen budget",
    description: "Monthly cap on wiki-regeneration spend.",
  },
  {
    key: "embed",
    label: "Embed budget",
    description: "Monthly cap on embedding spend (capture + retry path).",
  },
  {
    key: "classify",
    label: "Classify budget",
    description: "Monthly cap on classification spend (link worker).",
  },
];

const sectionLabel: CSSProperties = {
  ...T.micro,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--wiki-count)",
  margin: 0,
};

const bodyText: CSSProperties = {
  ...T.bodySmall,
  color: "var(--heading-secondary)",
  margin: 0,
};

const bodySmallText: CSSProperties = {
  ...T.micro,
  color: "var(--heading-secondary)",
  margin: 0,
};

const titleText: CSSProperties = {
  ...T.body,
  fontWeight: 500,
  color: "var(--heading-color)",
  margin: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Render USD micros as a dollar string with 4 decimal places. */
function formatUsd(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function SpendPage() {
  const router = useRouter();
  const [data, setData] = useState<SpendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Local edit state for the three caps. Stored as input strings (USD)
  // so the form does not flicker while the user is typing.
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});
  const [savingKind, setSavingKind] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/spend", { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const body = (await res.json()) as SpendResponse;
      setData(body);
      setError(null);
      setBudgetEdits({
        regen: (body.budgets.regen.limitUsdMicros / 1_000_000).toString(),
        embed: (body.budgets.embed.limitUsdMicros / 1_000_000).toString(),
        classify: (body.budgets.classify.limitUsdMicros / 1_000_000).toString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load spend");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const saveBudget = async (kind: "regen" | "embed" | "classify") => {
    const raw = budgetEdits[kind] ?? "";
    const usd = Number(raw);
    if (!Number.isFinite(usd) || usd < 0) {
      setSaveError(`Invalid ${kind} budget`);
      return;
    }
    setSavingKind(kind);
    setSaveError(null);
    try {
      const res = await fetch(`/api/settings/budgets/${kind}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit_usd_micros: Math.round(usd * 1_000_000) }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingKind(null);
    }
  };

  // Sort stages by canonical order so the UI is stable across reloads
  // even when one stage has zero events this month.
  const sortedStages = data?.byStage
    ? [...data.byStage].sort(
        (a, b) =>
          STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
      )
    : [];

  // Bar widths are scaled to the largest stage so the visual is honest
  // even for low-volume months.
  const maxStageCost = sortedStages.reduce(
    (acc, r) => Math.max(acc, r.costUsdMicros),
    0,
  );

  return (
    <AuthGuard>
      <div className="min-h-screen overflow-y-auto bg-background text-foreground">
        <div className="mx-auto max-w-[780px] px-10 pt-12 pb-20">
          <button
            type="button"
            onClick={() => router.push("/profile")}
            className="mb-6 -ml-2 flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-2"
            style={{ ...T.bodySmall, color: "var(--wiki-count)" }}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
            Back to profile
          </button>

          <h1
            style={{
              ...T.h1,
              fontFamily: FONT.SERIF,
              color: "var(--heading-color)",
              margin: 0,
            }}
          >
            Spend
          </h1>
          <p style={{ ...bodyText, marginTop: 4 }}>
            Cost this month, broken down by pipeline stage. Edit budget caps
            below.
          </p>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner className="size-5" />
            </div>
          ) : error ? (
            <p style={{ ...T.micro, color: "var(--destructive)", marginTop: 24 }}>
              {error}
            </p>
          ) : data ? (
            <>
              {/* This-month total */}
              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>This month</p>
                <Card size="sm" className="rounded-none">
                  <CardContent>
                    <div className="flex items-end justify-between">
                      <div>
                        <p
                          style={{
                            ...T.h1,
                            fontFamily: FONT.SERIF,
                            color: "var(--heading-color)",
                            margin: 0,
                          }}
                        >
                          {formatUsd(data.totalCostUsdMicros)}
                        </p>
                        <p style={{ ...bodySmallText, marginTop: 4 }}>
                          {formatTokens(data.totalTokens)} tokens since{" "}
                          {new Date(data.rangeStart).toLocaleDateString(
                            "en-US",
                            { month: "short", day: "numeric" },
                          )}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </section>

              {/* Stage breakdown */}
              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>By stage</p>
                <Card size="sm" className="rounded-none">
                  <CardContent>
                    {sortedStages.length === 0 ? (
                      <p style={bodySmallText}>
                        No usage events recorded yet. Capture a thought to
                        seed the dashboard.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {sortedStages.map((row) => {
                          const widthPct =
                            maxStageCost > 0
                              ? Math.max(
                                  2,
                                  Math.round((row.costUsdMicros / maxStageCost) * 100),
                                )
                              : 0;
                          return (
                            <div key={row.stage}>
                              <div className="flex items-baseline justify-between gap-3">
                                <span style={titleText}>
                                  {STAGE_LABELS[row.stage] ?? row.stage}
                                </span>
                                <span
                                  style={{
                                    ...T.micro,
                                    color: "var(--wiki-count)",
                                  }}
                                >
                                  {formatUsd(row.costUsdMicros)}{" "}
                                  <span style={{ opacity: 0.6 }}>
                                    {formatTokens(row.totalTokens)} tok ·{" "}
                                    {row.eventCount} events
                                  </span>
                                </span>
                              </div>
                              <div
                                style={{
                                  marginTop: 4,
                                  height: 6,
                                  background: "var(--muted)",
                                }}
                              >
                                <div
                                  style={{
                                    height: 6,
                                    width: `${widthPct}%`,
                                    background:
                                      "color-mix(in srgb, var(--heading-color) 60%, transparent)",
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </section>

              {/* Budget caps */}
              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>Budget caps</p>
                <Card size="sm" className="rounded-none">
                  <CardContent>
                    <p style={bodySmallText}>
                      Caps are advisory for v0.2.0. Wiring caps into the
                      worker scheduler lands in a follow-up.
                    </p>
                    <div
                      className="mt-4 flex flex-col gap-4"
                      style={{ display: "flex", flexDirection: "column" }}
                    >
                      {BUDGET_KINDS.map((kind) => (
                        <div key={kind.key} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p style={titleText}>{kind.label}</p>
                              <p style={{ ...bodySmallText, marginTop: 2 }}>
                                {kind.description}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span
                                style={{
                                  ...T.micro,
                                  color: "var(--wiki-count)",
                                }}
                              >
                                $
                              </span>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={budgetEdits[kind.key] ?? ""}
                                onChange={(e) =>
                                  setBudgetEdits((prev) => ({
                                    ...prev,
                                    [kind.key]: e.target.value,
                                  }))
                                }
                                style={{ width: 120 }}
                              />
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void saveBudget(kind.key)}
                                disabled={savingKind === kind.key}
                              >
                                <span style={T.buttonSmall}>
                                  {savingKind === kind.key
                                    ? "Saving..."
                                    : "Save"}
                                </span>
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {saveError && (
                      <p
                        style={{
                          ...T.micro,
                          color: "var(--destructive)",
                          marginTop: 8,
                        }}
                      >
                        {saveError}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </section>

              {/* Outstanding work placeholder */}
              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>Outstanding work</p>
                <Card size="sm" className="rounded-none">
                  <CardContent>
                    <p style={bodySmallText}>
                      Fragment-relationship backfill and last-cron-run
                      timestamps land in a follow-up wave. This section is
                      reserved for that surface.
                    </p>
                    <dl className="mt-3 flex flex-col gap-1.5">
                      <Row
                        label="Fragment relationship backfill queue"
                        value={
                          data.outstanding.fragmentRelationshipBackfillQueueDepth ?? "—"
                        }
                      />
                      <Row
                        label="Last cron run"
                        value={data.outstanding.lastCronRunAt ?? "—"}
                      />
                    </dl>
                  </CardContent>
                </Card>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </AuthGuard>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span style={bodySmallText}>{label}</span>
      <span style={{ ...T.micro, color: "var(--heading-color)" }}>
        {value}
      </span>
    </div>
  );
}

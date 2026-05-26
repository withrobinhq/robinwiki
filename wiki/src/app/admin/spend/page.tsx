"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { Card, CardContent } from "@/components/ui/card";
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

interface SpendResponse {
  rangeStart: string;
  rangeEnd: string;
  totalCostUsdMicros: number;
  totalTokens: number;
  byStage: SpendStageRollup[];
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/settings/spend", { credentials: "include" });
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const body = (await res.json()) as SpendResponse;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load spend");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
            onClick={() => router.push("/admin")}
            className="mb-6 -ml-2 flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-2"
            style={{ ...T.bodySmall, color: "var(--wiki-count)" }}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
            Back to admin
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
            Cost this month, broken down by pipeline stage.
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

            </>
          ) : null}
        </div>
      </div>
    </AuthGuard>
  );
}

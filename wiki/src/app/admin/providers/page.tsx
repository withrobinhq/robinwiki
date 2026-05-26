"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthGuard } from "@/components/AuthGuard";

interface StageInfo {
  model: string;
  updatedAt: string | null;
}

interface ProvidersResponse {
  provider: string;
  endpoint: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  stages: {
    extraction: StageInfo | null;
    classification: StageInfo | null;
    wikiGeneration: StageInfo | null;
    embedding: StageInfo | null;
  };
}

const STAGES: Array<{ key: keyof ProvidersResponse["stages"]; label: string; description: string }> = [
  { key: "extraction", label: "Extraction", description: "Extracts atomic ideas from raw thoughts" },
  { key: "classification", label: "Classification", description: "Classifies fragments into topic clusters" },
  { key: "wikiGeneration", label: "Wiki generation", description: "Generates and updates wiki pages" },
  { key: "embedding", label: "Embedding", description: "Vector embeddings (1536-dim only)" },
];

export default function ProvidersPage() {
  const router = useRouter();
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/providers", { credentials: "include" });
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const body = (await res.json()) as ProvidersResponse;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load providers");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
            Providers
          </h1>
          <p style={{ ...T.bodySmall, color: "var(--heading-secondary)", marginTop: 4 }}>
            Read-only view of every external endpoint Robin&apos;s pipeline calls.
            Editing happens via environment variables.
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
              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>External endpoint</p>
                <Card size="sm" className="rounded-none">
                  <CardContent className="space-y-3">
                    <Row label="Provider" value={prettyProvider(data.provider)} />
                    <Row label="Base URL" value={data.endpoint} mono />
                    <Row
                      label="API key"
                      value={
                        data.apiKeyConfigured
                          ? data.apiKeyHint || "configured"
                          : "not configured"
                      }
                      mono
                      tone={data.apiKeyConfigured ? "default" : "warning"}
                    />
                  </CardContent>
                </Card>
              </section>

              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>Routing per stage</p>
                <Card size="sm" className="rounded-none">
                  <CardContent className="space-y-4">
                    {STAGES.map((stage) => {
                      const info = data.stages[stage.key];
                      return (
                        <div key={stage.key} className="space-y-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <p
                              style={{
                                ...T.body,
                                fontWeight: 500,
                                color: "var(--heading-color)",
                                margin: 0,
                              }}
                            >
                              {stage.label}
                            </p>
                            <p
                              style={{
                                ...T.micro,
                                color: "var(--wiki-count)",
                                fontFamily: FONT.MONO,
                                margin: 0,
                                textAlign: "right",
                              }}
                            >
                              {info?.model ?? <em>using default</em>}
                            </p>
                          </div>
                          <p
                            style={{
                              ...T.micro,
                              color: "var(--heading-secondary)",
                              margin: 0,
                            }}
                          >
                            {stage.description}
                          </p>
                          {info?.updatedAt && (
                            <p
                              style={{
                                ...T.tiny,
                                color: "var(--wiki-count)",
                                margin: 0,
                              }}
                            >
                              Last validated {new Date(info.updatedAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </section>

              <section
                className="mt-8"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <p style={sectionLabel}>Change a model</p>
                <Card size="sm" className="rounded-none">
                  <CardContent className="flex items-center justify-between gap-3">
                    <p
                      style={{
                        ...T.bodySmall,
                        color: "var(--heading-secondary)",
                        margin: 0,
                      }}
                    >
                      Per-stage model selection lives on the profile page.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => router.push("/admin")}
                    >
                      <span style={T.buttonSmall}>Open profile</span>
                    </Button>
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

const sectionLabel: React.CSSProperties = {
  ...T.micro,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--wiki-count)",
  margin: 0,
};

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: "default" | "warning";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p style={{ ...T.bodySmall, color: "var(--heading-secondary)", margin: 0 }}>
        {label}
      </p>
      <p
        style={{
          ...T.bodySmall,
          margin: 0,
          fontFamily: mono ? FONT.MONO : undefined,
          color:
            tone === "warning"
              ? "var(--destructive)"
              : "var(--heading-color)",
          textAlign: "right",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </p>
    </div>
  );
}

function prettyProvider(p: string): string {
  if (p === "openrouter") return "OpenRouter";
  return p;
}

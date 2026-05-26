"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  KeyRound,
  Network,
  RefreshCw,
  Layers,
  RefreshCw as RefreshCwIcon,
  DollarSign,
} from "lucide-react";
import { T, FONT } from "@/lib/typography";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/hooks/useSession";
import { AuthGuard } from "@/components/AuthGuard";
import { useProfile } from "@/hooks/useProfile";
import { regenerateMcpEndpoint, revealUserKeypair } from "@/lib/api";
import { passwordPromptDialog } from "@/lib/passwordPromptDialog";

const sectionLabel: CSSProperties = {
  ...T.micro,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--wiki-count)",
  margin: 0,
};

const dangerLabel: CSSProperties = {
  ...sectionLabel,
  color: "var(--destructive)",
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

type RegenState = "idle" | "confirming" | "success";

/**
 * /admin — workspace-level administrative controls.
 *
 * Layout:
 *   Top: four inline sections — MCP Connection, Export all data,
 *     Export keypair, Danger zone.
 *   Bottom: cards linking to the four standalone subroutes that were
 *     already pages — wiki-types, providers, backfill, spend.
 *
 * In personal mode every user is implicitly Admin. In enterprise mode
 * this page is role-gated to Admins only (gating not in this PR; see
 * the enterprise PRD for the auth layer scope).
 */
export default function AdminPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, isLoading: sessionLoading } = useSession();
  const profileQuery = useProfile();

  // MCP connection state (moved from /profile)
  const [copied, setCopied] = useState(false);
  const [regenState, setRegenState] = useState<RegenState>("idle");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regeneratedUrl, setRegeneratedUrl] = useState<string | null>(null);
  const [regenCopied, setRegenCopied] = useState(false);

  // Danger zone state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Keypair-export error state
  const [keypairError, setKeypairError] = useState<string | null>(null);

  const username = session?.user?.name ?? session?.user?.email ?? "";
  const canDelete = username.length > 0 && deleteConfirm === username;
  const endpointUrl = profileQuery.data?.mcpEndpointUrl ?? "";

  const handleCopy = () => {
    navigator.clipboard.writeText(endpointUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleStartRegen = () => {
    setRegenError(null);
    setRegenState("confirming");
  };

  const handleCancelRegen = () => {
    if (regenLoading) return;
    setRegenError(null);
    setRegenState("idle");
  };

  const handleConfirmRegen = async () => {
    setRegenLoading(true);
    setRegenError(null);
    try {
      const { data } = await regenerateMcpEndpoint({ credentials: "include" });
      if (data?.mcpEndpointUrl) {
        setRegeneratedUrl(data.mcpEndpointUrl);
        setRegenState("success");
        await queryClient.invalidateQueries({ queryKey: ["profile"] });
      } else {
        setRegenError("Couldn't regenerate. Try again.");
      }
    } catch {
      setRegenError("Couldn't regenerate. Try again.");
    } finally {
      setRegenLoading(false);
    }
  };

  const handleDoneRegen = () => {
    setRegenState("idle");
    setRegeneratedUrl(null);
    setRegenError(null);
  };

  const handleCopyRegenerated = () => {
    if (!regeneratedUrl) return;
    navigator.clipboard.writeText(regeneratedUrl);
    setRegenCopied(true);
    setTimeout(() => setRegenCopied(false), 2000);
  };

  const triggerJsonDownload = (data: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportData = async () => {
    try {
      const res = await fetch("/api/users/export?format=zip", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return;
      const blob = await res.blob();
      triggerBlobDownload(blob, "robin-export.zip");
    } catch {
      // silently fail
    }
  };

  const handleExportKeypair = async () => {
    setKeypairError(null);
    const password = await passwordPromptDialog();
    if (!password) return;
    try {
      const { data, response } = await revealUserKeypair({
        body: { password },
        credentials: "include",
      });
      if (data) {
        triggerJsonDownload(data, "robin-keypair.json");
        return;
      }
      if (response.status === 401) {
        setKeypairError("Invalid password");
      } else if (response.status === 429) {
        setKeypairError("Too many attempts. Try again later.");
      } else {
        setKeypairError("Could not export keypair. Try again later.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.toLowerCase().includes("invalid")) {
        setKeypairError("Invalid password");
      } else if (
        message.includes("429") ||
        message.toLowerCase().includes("too many")
      ) {
        setKeypairError("Too many attempts. Try again later.");
      } else {
        setKeypairError("Could not export keypair. Try again later.");
      }
    }
  };

  if (sessionLoading || profileQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <AuthGuard>
      <div
        className="min-h-screen overflow-y-auto"
        style={{ background: "var(--background)", color: "var(--foreground)" }}
      >
        <div className="mx-auto max-w-[780px] px-10 pt-12 pb-20">
          {/* Back navigation */}
          <button
            type="button"
            onClick={() => router.push("/wiki")}
            className="mb-6 -ml-2 flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-2"
            style={{ ...T.bodySmall, color: "var(--wiki-count)" }}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
            Back
          </button>

          {/* Header */}
          <h1
            style={{
              ...T.h1,
              fontFamily: FONT.SERIF,
              color: "var(--heading-color)",
              margin: 0,
            }}
          >
            Admin
          </h1>
          <p style={{ ...bodyText, marginTop: 4 }}>
            Workspace-wide administrative controls
          </p>

          {/* 7. MCP CONNECTION */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>MCP Connection</p>

            <Card size="sm" className="gap-3 rounded-none">
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <p style={bodyText}>Status</p>
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    <span
                      style={{
                        ...T.body,
                        fontWeight: 500,
                        color: "var(--emerald-600, #059669)",
                      }}
                    >
                      Connected
                    </span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <p
                      style={{
                        ...T.tiny,
                        fontWeight: 500,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--wiki-count)",
                        margin: 0,
                      }}
                    >
                      Endpoint
                    </p>
                    {regenState === "idle" && (
                      <button
                        type="button"
                        onClick={handleStartRegen}
                        className="flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent"
                        style={{ ...T.micro, color: "var(--wiki-count)" }}
                      >
                        <RefreshCw className="size-3.5" strokeWidth={1.5} />
                        Regenerate
                      </button>
                    )}
                  </div>
                  <div
                    className="mt-1.5 flex items-center gap-3"
                    style={{
                      border: "1px solid var(--card-border)",
                      background: "var(--muted)",
                      padding: "10px 14px",
                    }}
                  >
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--wiki-count)",
                        margin: 0,
                        minWidth: 0,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {regenState === "success" && regeneratedUrl
                        ? regeneratedUrl
                        : endpointUrl}
                    </p>
                    <button
                      type="button"
                      onClick={
                        regenState === "success"
                          ? handleCopyRegenerated
                          : handleCopy
                      }
                      title={
                        regenState === "success"
                          ? regenCopied
                            ? "Copied!"
                            : "Copy new endpoint"
                          : copied
                            ? "Copied!"
                            : "Copy endpoint"
                      }
                      className="flex shrink-0 cursor-pointer border-none bg-transparent"
                      style={{
                        color: "var(--wiki-count)",
                        transition: "color 0.15s",
                      }}
                    >
                      {(regenState === "success" ? regenCopied : copied) ? (
                        <Check className="size-4" strokeWidth={1.75} />
                      ) : (
                        <Copy className="size-4" strokeWidth={1.5} />
                      )}
                    </button>
                  </div>
                </div>

                {regenState === "confirming" && (
                  <div
                    className="space-y-3"
                    style={{
                      border:
                        "1px solid color-mix(in srgb, var(--destructive) 30%, transparent)",
                      background:
                        "color-mix(in srgb, var(--destructive) 6%, transparent)",
                      padding: "12px 14px",
                    }}
                  >
                    <div>
                      <p
                        style={{
                          ...T.body,
                          fontWeight: 500,
                          color: "var(--heading-color)",
                          margin: 0,
                        }}
                      >
                        Regenerate MCP link?
                      </p>
                      <p style={{ ...bodySmallText, marginTop: 4 }}>
                        This invalidates the current MCP URL. Every connected
                        MCP client (Claude Desktop, Cursor, etc.) will stop
                        working until the new URL is pasted into each one.
                        There&apos;s no undo &mdash; the old URL is gone the
                        moment you confirm.
                      </p>
                    </div>
                    {regenError && (
                      <div
                        className="text-destructive"
                        style={{ ...T.micro }}
                      >
                        {regenError}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleCancelRegen}
                        disabled={regenLoading}
                      >
                        <span style={T.buttonSmall}>Cancel</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleConfirmRegen}
                        disabled={regenLoading}
                        className="bg-destructive text-white hover:bg-destructive/90 disabled:opacity-50"
                      >
                        {regenLoading ? (
                          <span className="flex items-center gap-2">
                            <Spinner className="size-3.5" />
                            <span style={T.buttonSmall}>Regenerating...</span>
                          </span>
                        ) : (
                          <span style={T.buttonSmall}>Yes, regenerate</span>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {regenState === "success" && (
                  <div
                    className="flex items-center justify-between gap-3"
                    style={{
                      border:
                        "1px solid color-mix(in srgb, var(--emerald-600, #059669) 30%, transparent)",
                      background:
                        "color-mix(in srgb, var(--emerald-600, #059669) 6%, transparent)",
                      padding: "10px 14px",
                    }}
                  >
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--heading-secondary)",
                        margin: 0,
                      }}
                    >
                      New URL generated. Paste it into every MCP client before
                      closing.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleDoneRegen}
                    >
                      <span style={T.buttonSmall}>Done</span>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          {/* SUBROUTE CARDS — 4 admin subroutes that have their own pages */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Sections</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SubrouteCard
                title="Wiki Types"
                description="Manage wiki type definitions and per-type prompts"
                icon={<Layers className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/admin/wiki-types")}
              />
              <SubrouteCard
                title="Providers + AI Models"
                description="OpenRouter config and per-stage model assignment"
                icon={<Network className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/admin/providers")}
              />
              <SubrouteCard
                title="Backfill"
                description="Detect and fill agent_schema gaps"
                icon={<RefreshCwIcon className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/admin/backfill")}
              />
              <SubrouteCard
                title="Spend"
                description="Cost dashboard and budget configuration"
                icon={<DollarSign className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/admin/spend")}
              />
            </div>
          </section>

          {/* 12-13. DATA — Export all data + Export keypair */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Data</p>
            <Card size="sm" className="rounded-none">
              <CardContent className="space-y-5">
                <ActionRow
                  title="Export all data"
                  description="Download wikis, entries, fragments, people, and graph as a zip"
                  icon={<Download className="size-4" strokeWidth={1.5} />}
                  onClick={handleExportData}
                />
                <ActionRow
                  title="Export keypair"
                  description="Download the workspace's Ed25519 public and private key as JSON"
                  icon={<KeyRound className="size-4" strokeWidth={1.5} />}
                  onClick={handleExportKeypair}
                />
                {keypairError && (
                  <p
                    style={{
                      ...T.micro,
                      color: "var(--destructive)",
                      margin: 0,
                    }}
                  >
                    {keypairError}
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          {/* 14. DANGER ZONE */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={dangerLabel}>Danger zone</p>
            <Card
              size="sm"
              className="rounded-none"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--destructive) 30%, transparent)",
              }}
            >
              <CardContent>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p style={titleText}>Delete all data</p>
                    <p style={{ ...bodySmallText, marginTop: 2 }}>
                      Permanently delete all wikis and people
                    </p>
                  </div>
                  <Dialog
                    open={deleteOpen}
                    onOpenChange={(open) => {
                      setDeleteOpen(open);
                      if (!open) setDeleteConfirm("");
                    }}
                  >
                    <DialogTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          className="bg-destructive text-white hover:bg-destructive/90"
                        >
                          <span style={T.buttonSmall}>Delete</span>
                        </Button>
                      }
                    />
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Delete all data</DialogTitle>
                        <DialogDescription>
                          This permanently deletes all wikis and people. This
                          action cannot be undone.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-2">
                        <Label
                          htmlFor="delete-confirm"
                          style={{
                            ...T.micro,
                            color: "var(--heading-secondary)",
                          }}
                        >
                          Type{" "}
                          <span
                            style={{
                              fontFamily: FONT.MONO,
                              fontWeight: 600,
                              color: "var(--heading-color)",
                            }}
                          >
                            {username}
                          </span>{" "}
                          to confirm.
                        </Label>
                        <Input
                          id="delete-confirm"
                          autoComplete="off"
                          value={deleteConfirm}
                          onChange={(e) => setDeleteConfirm(e.target.value)}
                          placeholder={username}
                        />
                      </div>
                      <DialogFooter>
                        <DialogClose
                          render={
                            <Button type="button" variant="outline" size="sm">
                              <span style={T.buttonSmall}>Cancel</span>
                            </Button>
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={!canDelete}
                          className="bg-destructive text-white hover:bg-destructive/90 disabled:opacity-50"
                          onClick={() => {
                            setDeleteOpen(false);
                            setDeleteConfirm("");
                          }}
                        >
                          <span style={T.buttonSmall}>Delete everything</span>
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </AuthGuard>
  );
}

function ActionRow({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center justify-between gap-4 border-none bg-transparent text-left"
    >
      <div className="min-w-0">
        <p
          style={{
            ...T.body,
            fontWeight: 500,
            color: "var(--heading-color)",
            margin: 0,
          }}
        >
          {title}
        </p>
        <p
          style={{
            ...T.micro,
            color: "var(--heading-secondary)",
            margin: 0,
            marginTop: 2,
          }}
        >
          {description}
        </p>
      </div>
      <span
        className="shrink-0"
        style={{ color: "var(--wiki-count)", transition: "color 0.15s" }}
      >
        {icon}
      </span>
    </button>
  );
}

function SubrouteCard({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Card size="sm" className="rounded-none">
      <CardContent>
        <button
          type="button"
          onClick={onClick}
          className="flex w-full cursor-pointer items-start gap-3 border-none bg-transparent text-left"
        >
          <span
            className="mt-0.5 shrink-0"
            style={{ color: "var(--wiki-count)" }}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <p
              style={{
                ...T.body,
                fontWeight: 500,
                color: "var(--heading-color)",
                margin: 0,
              }}
            >
              {title}
            </p>
            <p
              style={{
                ...T.micro,
                color: "var(--heading-secondary)",
                margin: 0,
                marginTop: 2,
              }}
            >
              {description}
            </p>
          </div>
        </button>
      </CardContent>
    </Card>
  );
}

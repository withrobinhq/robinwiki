"use client";

import { useState } from "react";
import { type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  KeyRound,
  LogOut,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { ModelSelector } from "@/components/ModelSelector";
import {
  isEmbeddingModel,
  useModelPreferences,
} from "@/hooks/useModelPreferences";

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
import { useStats } from "@/hooks/useStats";
import { useLogout } from "@/hooks/useLogout";
import { useChangePassword } from "@/hooks/useChangePassword";
import { exportUserData, regenerateMcpEndpoint, revealUserKeypair } from "@/lib/api";
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

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, isLoading: sessionLoading } = useSession();
  const profileQuery = useProfile();
  const statsQuery = useStats();
  const modelPrefs = useModelPreferences();
  const logout = useLogout();
  const changePassword = useChangePassword();
  const [copied, setCopied] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [regenState, setRegenState] = useState<RegenState>("idle");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regeneratedUrl, setRegeneratedUrl] = useState<string | null>(null);
  const [regenCopied, setRegenCopied] = useState(false);

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
        // Refresh cached profile so other consumers see the new URL too.
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
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportData = async () => {
    try {
      const { data } = await exportUserData({ credentials: "include" });
      if (data) triggerJsonDownload(data, "robin-export.json");
    } catch {
      // silently fail — user sees no download
    }
  };

  const [keypairError, setKeypairError] = useState<string | null>(null);
  const handleExportKeypair = async () => {
    setKeypairError(null);
    const password = await passwordPromptDialog();
    if (!password) return; // user cancelled
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
      // The shared client throws ApiError on non-OK responses. Surface a
      // useful message inline rather than silently swallowing.
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.toLowerCase().includes("invalid")) {
        setKeypairError("Invalid password");
      } else if (message.includes("429") || message.toLowerCase().includes("too many")) {
        setKeypairError("Too many attempts. Try again later.");
      } else {
        setKeypairError("Could not export keypair. Try again later.");
      }
    }
  };

  const stats = [
    { count: statsQuery.data?.totalNotes ?? 0, label: "Fragments" },
    { count: statsQuery.data?.unthreadedCount ?? 0, label: "Unattached Fragments" },
    { count: statsQuery.data?.totalThreads ?? 0, label: "Wikis" },
    { count: statsQuery.data?.peopleCount ?? 0, label: "People" },
  ];

  if (sessionLoading || profileQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <AuthGuard>
    <div className="min-h-screen overflow-y-auto" style={{ background: "var(--background)", color: "var(--foreground)" }}>
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

        {/* Profile header */}
        <h1 style={{ ...T.h1, fontFamily: FONT.SERIF, color: "var(--heading-color)", margin: 0 }}>
          Profile
        </h1>
        <p style={{ ...bodyText, marginTop: 4 }}>
          Your Robin control panel
        </p>

        {/* MCP CONNECTION */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>MCP Connection</p>

          <Card size="sm" className="gap-3 rounded-none">
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <p style={bodyText}>Status</p>
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  <span style={{ ...T.body, fontWeight: 500, color: "var(--emerald-600, #059669)" }}>
                    Connected
                  </span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <p style={{ ...T.tiny, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--wiki-count)", margin: 0 }}>
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
                <div className="mt-1.5 flex items-center gap-3" style={{ border: "1px solid var(--card-border)", background: "var(--muted)", padding: "10px 14px" }}>
                  <p style={{ ...T.micro, color: "var(--wiki-count)", margin: 0, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {regenState === "success" && regeneratedUrl ? regeneratedUrl : endpointUrl}
                  </p>
                  <button
                    type="button"
                    onClick={
                      regenState === "success" ? handleCopyRegenerated : handleCopy
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
                    style={{ color: "var(--wiki-count)", transition: "color 0.15s" }}
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
                    border: "1px solid color-mix(in srgb, var(--destructive) 30%, transparent)",
                    background: "color-mix(in srgb, var(--destructive) 6%, transparent)",
                    padding: "12px 14px",
                  }}
                >
                  <div>
                    <p style={{ ...T.body, fontWeight: 500, color: "var(--heading-color)", margin: 0 }}>
                      Regenerate MCP link?
                    </p>
                    <p style={{ ...bodySmallText, marginTop: 4 }}>
                      This invalidates your current MCP URL. Every connected MCP
                      client (Claude Desktop, Cursor, etc.) will stop working
                      until you paste the new URL into each one. There&apos;s no
                      undo &mdash; the old URL is gone the moment you confirm.
                    </p>
                  </div>
                  {regenError && (
                    <div className="text-destructive" style={{ ...T.micro }}>
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
                    border: "1px solid color-mix(in srgb, var(--emerald-600, #059669) 30%, transparent)",
                    background: "color-mix(in srgb, var(--emerald-600, #059669) 6%, transparent)",
                    padding: "10px 14px",
                  }}
                >
                  <p style={{ ...T.micro, color: "var(--heading-secondary)", margin: 0 }}>
                    New URL generated. Paste it into every MCP client before closing.
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

        {/* KNOWLEDGE STATS */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>Knowledge Stats</p>

          <Card size="sm" className="gap-0 rounded-none py-0">
            <div className="grid grid-cols-4 divide-x divide-border">
              {stats.map((stat) => (
                <div key={stat.label} className="px-2 py-5 text-center">
                  <p style={{ ...T.h1, fontFamily: FONT.SERIF, color: "var(--heading-color)", margin: 0 }}>
                    {stat.count}
                  </p>
                  <p style={{ ...T.micro, color: "var(--wiki-count)", marginTop: 4, marginBottom: 0 }}>
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </section>

        {/* PROMPTS */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>Prompts</p>
          <Card size="sm" className="rounded-none">
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <p style={titleText}>
                  Customize prompts
                </p>
                <p style={{ ...bodySmallText, marginTop: 2 }}>
                  Edit how each wiki type structures your knowledge.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => router.push("/profile/prompts")}
              >
                <span style={T.buttonSmall}>Manage prompts</span>
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* AI MODELS */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>AI Models</p>

          <Card size="sm" className="rounded-none">
            <CardContent className="space-y-1">
              <p style={bodySmallText}>
                Configure which models Robin uses for each pipeline stage.
              </p>

              {modelPrefs.loading ? (
                <div className="flex items-center gap-2 py-4">
                  <Spinner className="size-4" />
                  <span style={{ ...T.micro, color: "var(--wiki-count)" }}>
                    Loading models...
                  </span>
                </div>
              ) : modelPrefs.error && !modelPrefs.preferences ? (
                <p style={{ ...T.micro, color: "var(--destructive)", paddingTop: 16, paddingBottom: 16 }}>
                  {modelPrefs.error}
                </p>
              ) : (
                <div className="grid gap-4 pt-2 sm:grid-cols-2">
                  <ModelSelector
                    label="Extraction"
                    description="Extracts atomic ideas from raw thoughts"
                    models={modelPrefs.models}
                    value={modelPrefs.preferences.extraction}
                    onChange={(id) =>
                      modelPrefs.updatePreference("extraction", id)
                    }
                    disabled={modelPrefs.saveStatus === "saving"}
                  />
                  <ModelSelector
                    label="Classification"
                    description="Classifies fragments into topic clusters"
                    models={modelPrefs.models}
                    value={modelPrefs.preferences.classification}
                    onChange={(id) =>
                      modelPrefs.updatePreference("classification", id)
                    }
                    disabled={modelPrefs.saveStatus === "saving"}
                  />
                  <ModelSelector
                    label="Wiki Generation"
                    description="Generates and updates wiki pages"
                    models={modelPrefs.models}
                    value={modelPrefs.preferences.wikiGeneration}
                    onChange={(id) =>
                      modelPrefs.updatePreference("wikiGeneration", id)
                    }
                    disabled={modelPrefs.saveStatus === "saving"}
                  />
                  <ModelSelector
                    label="Embeddings"
                    description="Creates vector embeddings (1536-dim only)"
                    models={modelPrefs.models}
                    value={modelPrefs.preferences.embedding}
                    onChange={(id) =>
                      modelPrefs.updatePreference("embedding", id)
                    }
                    filterFn={isEmbeddingModel}
                    disabled={modelPrefs.saveStatus === "saving"}
                  />
                </div>
              )}

              {modelPrefs.saveStatus !== "idle" && (
                <p
                  style={{
                    ...T.micro,
                    paddingTop: 4,
                    transition: "opacity 0.15s",
                    color:
                      modelPrefs.saveStatus === "saving"
                        ? "var(--wiki-count)"
                        : modelPrefs.saveStatus === "saved"
                          ? "var(--emerald-600, #059669)"
                          : "var(--destructive)",
                  }}
                >
                  {modelPrefs.saveStatus === "saving" && "Saving..."}
                  {modelPrefs.saveStatus === "saved" && "Saved"}
                  {modelPrefs.saveStatus === "error" && "Failed to save"}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* USER MANAGEMENT — owner identity (name + wiki count) */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>User Management</p>

          <Card size="sm" className="rounded-none">
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span style={titleText}>
                    {profileQuery.data?.name ?? username}
                  </span>
                  <span style={{ ...T.micro, color: "var(--wiki-count)" }}>
                    {statsQuery.data?.totalThreads ?? 0} wikis
                  </span>
                </div>
                <button
                  type="button"
                  className="flex shrink-0 cursor-pointer border-none bg-transparent"
                  style={{ color: "var(--wiki-count)", transition: "color 0.15s" }}
                  title="Edit vault"
                >
                  <Pencil className="size-4" strokeWidth={1.5} />
                </button>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* DATA */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>Data</p>
          <Card size="sm" className="rounded-none">
            <CardContent className="space-y-5">
              <ActionRow
                title="Export all data"
                description="Download all wikis and people as JSON"
                icon={<Download className="size-4" strokeWidth={1.5} />}
                onClick={handleExportData}
              />
              <ActionRow
                title="Export keypair"
                description="Download your Ed25519 public and private key as JSON"
                icon={<KeyRound className="size-4" strokeWidth={1.5} />}
                onClick={handleExportKeypair}
              />
              {keypairError && (
                <p style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}>
                  {keypairError}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* LOG OUT */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>Session</p>
          <Card size="sm" className="rounded-none">
            <CardContent>
              <ActionRow
                title="Log out"
                description="Sign out of your account on this device"
                icon={<LogOut className="size-4" strokeWidth={1.5} />}
                onClick={logout}
              />
            </CardContent>
          </Card>
        </section>

        {/* SECURITY */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={sectionLabel}>Security</p>
          <Card size="sm" className="rounded-none">
            <CardContent className="space-y-4">
              <div>
                <p style={titleText}>Change password</p>
                <p style={{ ...bodySmallText, marginTop: 2 }}>
                  Update your account password.
                </p>
              </div>
              <form
                className="space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (newPw !== confirmPw) return;
                  await changePassword.mutate({ currentPassword: currentPw, newPassword: newPw });
                  if (!changePassword.error) {
                    setCurrentPw("");
                    setNewPw("");
                    setConfirmPw("");
                  }
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="current-password" style={{ ...T.micro, color: "var(--heading-secondary)" }}>
                    Current password
                  </Label>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-password" style={{ ...T.micro, color: "var(--heading-secondary)" }}>
                    New password
                  </Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="confirm-password" style={{ ...T.micro, color: "var(--heading-secondary)" }}>
                    Confirm new password
                  </Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                  />
                </div>
                {newPw.length > 0 && confirmPw.length > 0 && newPw !== confirmPw && (
                  <p style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}>
                    Passwords do not match.
                  </p>
                )}
                {changePassword.error && (
                  <p style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}>
                    {changePassword.error}
                  </p>
                )}
                {changePassword.isSuccess && (
                  <p style={{ ...T.micro, color: "var(--emerald-600, #059669)", margin: 0 }}>
                    Password changed successfully.
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    changePassword.isLoading ||
                    !currentPw ||
                    !newPw ||
                    !confirmPw ||
                    newPw !== confirmPw
                  }
                >
                  <span style={T.buttonSmall}>
                    {changePassword.isLoading ? "Changing..." : "Change password"}
                  </span>
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        {/* DANGER ZONE */}
        <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={dangerLabel}>Danger zone</p>
          <Card size="sm" className="rounded-none" style={{ borderColor: "color-mix(in srgb, var(--destructive) 30%, transparent)" }}>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p style={titleText}>
                    Delete all data
                  </p>
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
                      <Label htmlFor="delete-confirm" style={{ ...T.micro, color: "var(--heading-secondary)" }}>
                        Type{" "}
                        <span style={{ fontFamily: FONT.MONO, fontWeight: 600, color: "var(--heading-color)" }}>
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
        <p style={{ ...T.body, fontWeight: 500, color: "var(--heading-color)", margin: 0 }}>{title}</p>
        <p style={{ ...T.micro, color: "var(--heading-secondary)", margin: 0, marginTop: 2 }}>{description}</p>
      </div>
      <span className="shrink-0" style={{ color: "var(--wiki-count)", transition: "color 0.15s" }}>
        {icon}
      </span>
    </button>
  );
}

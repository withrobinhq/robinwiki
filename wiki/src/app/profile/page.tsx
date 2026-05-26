"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, LogOut, Lock } from "lucide-react";
import { T, FONT } from "@/lib/typography";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/hooks/useSession";
import { AuthGuard } from "@/components/AuthGuard";
import { useProfile } from "@/hooks/useProfile";
import { useStats } from "@/hooks/useStats";
import { useLogout } from "@/hooks/useLogout";
import { useChangePassword } from "@/hooks/useChangePassword";

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

/**
 * /profile — user-personal page. Four sections, ordered:
 *   1. Knowledge Stats (read-only counts; same display for all users)
 *   2. Password (auth security — change own password)
 *   3. 4-digit passcode (enterprise-only; rendered disabled + locked CTA in personal mode)
 *   4. Log out
 *
 * Admin-level controls (MCP connection, AI models, data export,
 * danger zone, providers, prompts) live under /admin. Per-wiki Guardian
 * controls live under /wiki-management.
 */
export default function ProfilePage() {
  const router = useRouter();
  const { isLoading: sessionLoading } = useSession();
  const profileQuery = useProfile();
  const statsQuery = useStats();
  const logout = useLogout();
  const changePassword = useChangePassword();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

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
            Profile
          </h1>
          <p style={{ ...bodyText, marginTop: 4 }}>Your personal controls</p>

          {/* 1. KNOWLEDGE STATS */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Knowledge Stats</p>

            <Card size="sm" className="gap-0 rounded-none py-0">
              <div className="grid grid-cols-4 divide-x divide-border">
                {stats.map((stat) => (
                  <div key={stat.label} className="px-2 py-5 text-center">
                    <p
                      style={{
                        ...T.h1,
                        fontFamily: FONT.SERIF,
                        color: "var(--heading-color)",
                        margin: 0,
                      }}
                    >
                      {stat.count}
                    </p>
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--wiki-count)",
                        marginTop: 4,
                        marginBottom: 0,
                      }}
                    >
                      {stat.label}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          </section>

          {/* 2. PASSWORD */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Password</p>
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
                    await changePassword.mutate({
                      currentPassword: currentPw,
                      newPassword: newPw,
                    });
                    if (!changePassword.error) {
                      setCurrentPw("");
                      setNewPw("");
                      setConfirmPw("");
                    }
                  }}
                >
                  <div className="space-y-1">
                    <Label
                      htmlFor="current-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
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
                    <Label
                      htmlFor="new-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
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
                    <Label
                      htmlFor="confirm-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
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
                  {newPw.length > 0 &&
                    confirmPw.length > 0 &&
                    newPw !== confirmPw && (
                      <p
                        style={{
                          ...T.micro,
                          color: "var(--destructive)",
                          margin: 0,
                        }}
                      >
                        Passwords do not match.
                      </p>
                    )}
                  {changePassword.error && (
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--destructive)",
                        margin: 0,
                      }}
                    >
                      {changePassword.error}
                    </p>
                  )}
                  {changePassword.isSuccess && (
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--emerald-600, #059669)",
                        margin: 0,
                      }}
                    >
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
                      {changePassword.isLoading
                        ? "Changing..."
                        : "Change password"}
                    </span>
                  </Button>
                </form>
              </CardContent>
            </Card>
          </section>

          {/* 3. 4-DIGIT PASSCODE (enterprise-only; locked in personal mode) */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>4-digit passcode</p>
            <Card
              size="sm"
              className="rounded-none"
              style={{
                borderColor: "var(--card-border)",
                background:
                  "color-mix(in srgb, var(--muted) 50%, transparent)",
              }}
            >
              <CardContent>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Lock
                        className="size-3.5"
                        strokeWidth={1.5}
                        style={{ color: "var(--wiki-count)" }}
                      />
                      <p style={titleText}>Your passcode</p>
                    </div>
                    <p style={{ ...bodySmallText, marginTop: 4 }}>
                      In enterprise mode, every user has a 4-digit passcode
                      that lets MCP calls from Claude or ChatGPT attribute
                      back to them in the audit log. Paste it into your
                      Claude project instructions and Robin will resolve
                      the passcode to you on every MCP request.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled
                    aria-label="Available in enterprise"
                  >
                    <span style={T.buttonSmall}>Available in enterprise</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* 4. LOG OUT */}
          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Session</p>
            <Card size="sm" className="rounded-none">
              <CardContent>
                <button
                  type="button"
                  onClick={logout}
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
                      Log out
                    </p>
                    <p
                      style={{
                        ...T.micro,
                        color: "var(--heading-secondary)",
                        margin: 0,
                        marginTop: 2,
                      }}
                    >
                      Sign out of your account on this device
                    </p>
                  </div>
                  <span
                    className="shrink-0"
                    style={{
                      color: "var(--wiki-count)",
                      transition: "color 0.15s",
                    }}
                  >
                    <LogOut className="size-4" strokeWidth={1.5} />
                  </span>
                </button>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </AuthGuard>
  );
}

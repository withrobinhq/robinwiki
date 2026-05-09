"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { AuthGuard } from "@/components/AuthGuard";
import { SettingsNav } from "./SettingsNav";

// Stream U: shared shell for the three operator panels. Holds AuthGuard,
// the back-to-profile chrome, the page title, and the side-nav. Each
// panel passes its own header text and main content as children.
//
// Match the existing /settings/providers and /settings/spend visual
// register: max-width content, 12pt top, ArrowLeft back-button, serif
// h1, micro secondary text underneath.

interface Props {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function SettingsShell({ title, subtitle, children }: Props) {
  const router = useRouter();

  return (
    <AuthGuard>
      <div className="min-h-screen overflow-y-auto bg-background text-foreground">
        <div
          className="mx-auto px-10 pt-12 pb-20"
          style={{ maxWidth: 1100 }}
        >
          <button
            type="button"
            onClick={() => router.push("/profile")}
            className="mb-6 -ml-2 flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-2"
            style={{ ...T.bodySmall, color: "var(--wiki-count)" }}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
            Back to profile
          </button>

          <div
            style={{
              display: "flex",
              gap: 48,
              alignItems: "flex-start",
            }}
          >
            <SettingsNav />

            <main
              style={{
                flex: 1,
                minWidth: 0,
              }}
            >
              <h1
                style={{
                  ...T.h1,
                  fontFamily: FONT.SERIF,
                  color: "var(--heading-color)",
                  margin: 0,
                }}
              >
                {title}
              </h1>
              {subtitle ? (
                <p
                  style={{
                    ...T.bodySmall,
                    color: "var(--heading-secondary)",
                    marginTop: 4,
                  }}
                >
                  {subtitle}
                </p>
              ) : null}

              <div style={{ marginTop: 32 }}>{children}</div>
            </main>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}

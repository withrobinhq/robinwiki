"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { AuthGuard } from "@/components/AuthGuard";

// Shared shell for the admin / wiki-management subpages. Holds
// AuthGuard, a parametrised back-button, the page title and subtitle,
// then renders children below.
//
// Caller passes `backTo` and `backLabel` so the same shell can serve
// pages under both /admin and /wiki-management. The previous
// SettingsNav side-nav has been removed — section-level navigation
// happens via the cards on the /admin and /wiki-management landing
// pages.
//
// Visual register matches /admin and /profile: max-width content,
// 12pt top, ArrowLeft back-button, serif h1, micro secondary text
// underneath.

interface Props {
  title: string;
  subtitle?: string;
  backTo: string;
  backLabel: string;
  children: React.ReactNode;
}

export function SettingsShell({
  title,
  subtitle,
  backTo,
  backLabel,
  children,
}: Props) {
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
            onClick={() => router.push(backTo)}
            className="mb-6 -ml-2 flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-2"
            style={{ ...T.bodySmall, color: "var(--wiki-count)" }}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
            {backLabel}
          </button>

          <main style={{ minWidth: 0 }}>
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
    </AuthGuard>
  );
}

"use client";

import { type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ListChecks, Users } from "lucide-react";
import { T, FONT } from "@/lib/typography";
import { Card, CardContent } from "@/components/ui/card";
import { AuthGuard } from "@/components/AuthGuard";

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

/**
 * /wiki-management — Guardian + Admin landing page.
 *
 * Two cards link to the workspace-level Guardian surfaces:
 *   - /wiki-management/wikis  — per-wiki autoregen / regen-now / publish
 *   - /wiki-management/people — auto-extracted person quarantine queue
 *
 * Per-wiki Settings (the Settings tab on each wiki's detail page) is
 * Guardian-controlled but lives on the wiki page itself, not here.
 */
export default function WikiManagementPage() {
  const router = useRouter();

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
            Wiki Management
          </h1>
          <p style={{ ...bodyText, marginTop: 4 }}>
            Workspace-level Guardian controls
          </p>

          <section
            className="mt-8"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={sectionLabel}>Sections</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SubrouteCard
                title="Wikis"
                description="Per-wiki autoregen, regenerate, and publish controls"
                icon={<ListChecks className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/wiki-management/wikis")}
              />
              <SubrouteCard
                title="People queue"
                description="Auto-extracted person quarantine — approve or reject"
                icon={<Users className="size-4" strokeWidth={1.5} />}
                onClick={() => router.push("/wiki-management/people")}
              />
            </div>
          </section>
        </div>
      </div>
    </AuthGuard>
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

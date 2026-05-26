"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { useWikiTypesList } from "@/hooks/useWikiTypesList";

export default function SettingsWikiTypesPage() {
  const { data, isLoading, error } = useWikiTypesList();

  return (
    <SettingsShell
      title="Wiki Types"
      subtitle="Manage wiki type definitions that control how wikis are classified and generated."
    >
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <Link href="/admin/wiki-types/new">
          <Button size="sm">
            <Plus className="size-3.5" strokeWidth={1.5} />
            Create wiki type
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <p style={{ ...T.bodySmall, color: "var(--destructive)" }}>
          Failed to load wiki types. Try refreshing the page.
        </p>
      ) : !data?.wikiTypes?.length ? (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--heading-secondary)",
          }}
        >
          <p style={{ ...T.body, margin: 0 }}>No wiki types yet.</p>
          <p style={{ ...T.micro, marginTop: 8 }}>
            Create your first wiki type to define how wikis are structured and
            generated.
          </p>
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            border: "1px solid var(--border)",
            borderBottom: "none",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {data.wikiTypes.map((wt) => (
            <li
              key={wt.slug}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "14px 16px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p
                  style={{
                    ...T.body,
                    fontWeight: 500,
                    color: "var(--heading-color)",
                    margin: 0,
                  }}
                >
                  {wt.displayLabel}
                </p>
                <p
                  style={{
                    ...T.micro,
                    color: "var(--heading-secondary)",
                    margin: 0,
                    marginTop: 2,
                  }}
                >
                  {wt.displayShortDescriptor}
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {wt.userModified && (
                  <Badge variant="secondary" className="text-[10px]">
                    modified
                  </Badge>
                )}
                <span
                  style={{
                    ...T.micro,
                    color: "var(--heading-secondary)",
                    fontFamily: "var(--font-ibm-plex-mono), monospace",
                  }}
                >
                  {wt.slug}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsShell>
  );
}

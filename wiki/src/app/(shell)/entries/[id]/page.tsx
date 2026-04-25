"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { T } from "@/lib/typography";
import { Spinner } from "@/components/ui/spinner";
import { ROUTES } from "@/lib/routes";
import { EntryArticle } from "@/components/wiki/EntryArticle";
import { WikiSectionH2 } from "@/components/wiki/WikiEntityArticle";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import { useEntry } from "@/hooks/useEntry";
import { useEntryFragments } from "@/hooks/useEntryFragments";
import { useRetryEntry } from "@/hooks/useRetryEntry";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function EntryPage() {
  const { id } = useParams<{ id: string }>();
  const { data: entry, isLoading, error } = useEntry(id);
  const { data: fragmentsData } = useEntryFragments(id);
  const fragments = fragmentsData?.fragments ?? [];
  const retryEntry = useRetryEntry();

  const bodyStyle = {
    ...T.bodySmall,
    color: "var(--wiki-article-text)",
    lineHeight: 1.6,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error || !entry) {
    return (
      <div className="p-6">
        <h1 style={T.h1}>Entry not found</h1>
        <p style={{ ...T.bodySmall, color: "var(--wiki-article-text)", marginTop: 8 }}>
          This entry could not be loaded. It may have been deleted or you may not have access.
        </p>
      </div>
    );
  }

  return (
    <>
    <Link href="/wiki" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--wiki-count)", textDecoration: "none", marginBottom: 12 }}>
      <ArrowLeft size={14} strokeWidth={1.5} />
      <span style={{ ...T.micro }}>Back</span>
    </Link>
    {entry.ingestStatus === "failed" && (
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "12px 16px",
          marginBottom: 16,
          border: "1px solid var(--destructive)",
          borderRadius: 6,
          backgroundColor: "color-mix(in srgb, var(--destructive) 8%, transparent)",
        }}
      >
        <AlertTriangle size={16} style={{ color: "var(--destructive)", flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ ...T.bodySmall, fontWeight: 600, color: "var(--destructive)", margin: 0 }}>
            Extraction failed
          </p>
          {entry.lastError && (
            <p style={{ ...T.micro, color: "var(--wiki-article-text)", margin: 0, opacity: 0.8 }}>
              {entry.lastError}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => retryEntry.mutate(id)}
            disabled={retryEntry.isPending}
            style={{ alignSelf: "flex-start", marginTop: 4 }}
          >
            <RefreshCw size={14} className={retryEntry.isPending ? "animate-spin" : ""} />
            Retry processing
          </Button>
        </div>
      </div>
    )}
    {entry.ingestStatus === "pending" && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          marginBottom: 16,
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      >
        <Spinner className="size-4" />
        <p style={{ ...T.bodySmall, color: "var(--wiki-article-text)", margin: 0 }}>
          Processing entry...
        </p>
      </div>
    )}
    <EntryArticle
      title={entry.title}
      infobox={{
        type: entry.type,
        source: entry.source,
        createdAt: formatDate(entry.createdAt),
      }}
      body={
        <MarkdownContent
          content={entry.content}
          refs={entry.refs}
          style={bodyStyle}
        />
      }
    >
      {fragments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <WikiSectionH2 title="Extracted Fragments" count={fragments.length} />
          <ul
            style={{
              ...bodyStyle,
              listStyle: "decimal",
              paddingLeft: 20,
              margin: "12px 0 0 0",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {fragments.map((frag) => (
              <li key={frag.id}>
                <Link
                  href={ROUTES.fragment(frag.id)}
                  style={{
                    color: "var(--wiki-fragment-link)",
                    textDecoration: "underline",
                    textDecorationSkipInk: "none",
                  }}
                >
                  {frag.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </EntryArticle>
    </>
  );
}

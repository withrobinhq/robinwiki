"use client";

import { useMemo } from "react";
import Link from "next/link";
import { T } from "@/lib/typography";
import { useWikis } from "@/hooks/useWikis";
import { EditorialStateDot } from "@/components/wiki/EditorialStateDot";
import type { EditorialStateSchema } from "@/lib/generated/types.gen";

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffDay < 1) return "today";
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 8) return `${diffWeek}w ago`;
  return new Date(dateStr).toLocaleDateString();
}

const BulletDot = () => (
  <svg
    width="8"
    height="8"
    viewBox="0 0 8 8"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 0C1.79086 0 0 1.79086 0 4C0 6.20914 1.79086 8 4 8C6.20914 8 8 6.20914 8 4C8 1.79086 6.20914 0 4 0Z"
      fill="var(--wiki-bullet)"
    />
  </svg>
);

interface RecentItem {
  title: string;
  updatedAgo: string;
  href: string;
  editorialState?: EditorialStateSchema;
}

export default function RecentlyUpdated() {
  const wikisQuery = useWikis();

  const items = useMemo<RecentItem[]>(() => {
    const threads = wikisQuery.data?.wikis ?? [];
    return [...threads]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5)
      .map((t) => ({
        title: t.name,
        updatedAgo: timeAgo(t.updatedAt),
        href: `/wiki/${t.lookupKey}`,
        editorialState: t.editorialState,
      }));
  }, [wikisQuery.data]);

  return (
    <div
      className="wiki-recently-updated"
      style={{
        border: "1px solid var(--wiki-card-border)",
        backgroundColor: "var(--profile-item-border)",
        display: "flex",
        flexDirection: "column" as const,
      }}
    >
      {/* Header */}
      <div
        style={{
          borderBottom: "1px solid var(--wiki-card-border)",
          padding: "10px 16px",
        }}
      >
        <p
          style={{
            ...T.h4,
            color: "var(--wiki-card-header)",
            whiteSpace: "nowrap",
          }}
        >
          Recently updated
        </p>
      </div>

      {/* Items */}
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-evenly", flex: 1, backgroundColor: "var(--color-background)" }}>
        {items.length === 0 && !wikisQuery.isLoading ? (
          <div style={{ padding: "12px 16px", ...T.bodySmall, color: "var(--wiki-item-date)" }}>
            No wikis yet.
          </div>
        ) : (
          items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "5px 12px 0px",
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {item.editorialState ? (
                  <EditorialStateDot editorialState={item.editorialState} />
                ) : (
                  <BulletDot />
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flex: 1,
                  minWidth: 0,
                  lineHeight: "20px",
                }}
              >
                <Link
                  href={item.href}
                  style={{
                    ...T.bodySmall,
                    color: "var(--wiki-item-link)",
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.title}
                </Link>
                <span
                  style={{
                    ...T.tiny,
                    color: "var(--wiki-item-date)",
                    whiteSpace: "nowrap",
                    marginLeft: 8,
                    padding: "4px 5px",
                  }}
                >
                  {item.updatedAgo}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

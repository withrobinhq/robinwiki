"use client";

import { useMemo } from "react";
import Link from "next/link";
import { FONT, T } from "@/lib/typography";
import { useWikis } from "@/hooks/useWikis";
import { useWikiTypesList } from "@/hooks/useWikiTypesList";
import { EditorialStateDot } from "@/components/wiki/EditorialStateDot";
import type { EditorialStateSchema } from "@/lib/generated/types.gen";

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffDay < 1) return "today";
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 52) return `${diffWeek}w ago`;
  return new Date(dateStr).toLocaleDateString();
}

function capitalize(s: string | null | undefined): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const BadgeIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 13.7339 14.3778"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6.88852 0.625124C7.46363 0.725143 7.70743 1.48779 8.18877 1.78785C8.3263 1.88787 8.47008 1.95663 8.63261 2.00039C9.48277 2.26294 10.5892 1.30025 10.9143 2.20668C11.0706 2.71303 10.9143 3.55069 11.3519 4.03203C11.7895 4.61339 12.8772 4.6509 13.071 5.1385C13.246 5.6761 12.6896 6.11368 12.5021 6.58878C12.4083 6.78882 12.3521 7.00136 12.3521 7.20765C12.2896 8.07656 13.5273 8.78295 12.9459 9.43933C12.4896 9.83941 11.727 9.87066 11.3456 10.377C10.7955 10.9521 11.2394 11.9523 10.708 12.4962C10.2454 12.8525 9.14521 12.0836 8.43257 12.4774C7.76369 12.7587 7.39487 13.7714 6.86977 13.7464C6.34466 13.7714 5.96959 12.7587 5.30696 12.4774C4.58807 12.0836 3.49411 12.8587 3.03152 12.4962C2.61269 12.1211 2.81273 11.446 2.6627 10.9459C2.54393 10.3082 1.97507 9.96443 1.40621 9.77064C1.0874 9.63937 0.681069 9.50184 0.63106 9.12677C0.562296 8.60167 1.41871 7.93279 1.3812 7.2014C1.3812 6.99511 1.32494 6.78256 1.23118 6.58253C1.04989 6.11368 0.487282 5.66985 0.662316 5.13225C0.887359 4.60714 2.15635 4.57589 2.50017 3.857C2.79398 3.37566 2.66895 2.65052 2.81898 2.20668C3.14405 1.30025 4.25676 2.26294 5.10067 2.00039C5.26321 1.95663 5.40698 1.88787 5.54451 1.78785C6.02585 1.48779 6.26965 0.725143 6.84476 0.625124H6.89477H6.88852Z"
      stroke="var(--wiki-badge-stroke)"
      strokeWidth="1.37339"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

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

interface WikiItem {
  title: string;
  date: string;
  href: string;
  editorialState?: EditorialStateSchema;
}

interface WikiCategory {
  name: string;
  items: WikiItem[];
}

function CategorySection({ category }: { category: WikiCategory }) {
  return (
    <div>
      {/* Category header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6.5,
          paddingBottom: 3.2,
        }}
      >
        <div
          style={{
            width: 16,
            height: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <BadgeIcon />
        </div>
        <p
          style={{
            ...T.h4,
            fontFamily: FONT.SERIF,
            fontWeight: 400,
            color: "var(--wiki-category-name)",
          }}
        >
          {category.name}
        </p>
      </div>

      {/* Items */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {category.items.map((item, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "4px 12px",
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
                gap: 21,
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
                }}
              >
                {item.date}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* See more */}
      <div style={{ padding: "4px 12px 0 38px" }}>
        <Link
          href={`/wiki?type=${encodeURIComponent(category.name.toLowerCase())}`}
          style={{
            ...T.caption,
            color: "var(--wiki-link)",
            textDecoration: "none",
          }}
        >
          See more
        </Link>
      </div>
    </div>
  );
}

export default function BrowseByType() {
  const wikiTypesQuery = useWikiTypesList();
  const wikisQuery = useWikis();

  const categories = useMemo<WikiCategory[]>(() => {
    const types = wikiTypesQuery.data?.wikiTypes ?? [];
    const threads = wikisQuery.data?.wikis ?? [];

    // Group wikis by their type
    const byType = new Map<string, WikiItem[]>();
    for (const t of threads) {
      const typeName = capitalize(t.type);
      if (!byType.has(typeName)) byType.set(typeName, []);
      byType.get(typeName)!.push({
        title: t.name,
        date: timeAgo(t.updatedAt),
        href: `/wiki/${t.lookupKey}`,
        editorialState: t.editorialState,
      });
    }

    // Build categories from wiki types, only including those with items
    if (types.length > 0) {
      return types
        .map((wt) => ({
          name: wt.displayLabel,
          items: (byType.get(wt.displayLabel) ?? []).slice(0, 2),
        }))
        .filter((c) => c.items.length > 0);
    }

    // Fallback: build categories from actual wiki data
    return Array.from(byType.entries())
      .map(([name, items]) => ({ name, items: items.slice(0, 2) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [wikiTypesQuery.data, wikisQuery.data]);

  return (
    <div
      style={{
        border: "1px solid var(--wiki-card-border)",
        backgroundColor: "var(--surface-subtle)",
        width: "100%",
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
          }}
        >
          Browse by wiki type
        </p>
      </div>

      {/* 2-column grid */}
      <div className="wiki-browse-grid" style={{ backgroundColor: "var(--color-background)" }}>
        {categories.length === 0 && !wikisQuery.isLoading ? (
          <p style={{ padding: "12px 16px", ...T.bodySmall, color: "var(--wiki-item-date)" }}>
            No wikis yet.
          </p>
        ) : (
          categories.map((cat, i) => (
            <CategorySection key={i} category={cat} />
          ))
        )}
      </div>
    </div>
  );
}

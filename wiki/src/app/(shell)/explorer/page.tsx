"use client";

import {
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import Link from "next/link";
import {
  SlidersHorizontal,
  FileCode,
  MessageSquare,
  NotebookText,
  UserRound,
  X,
} from "lucide-react";

import { FONT, T } from "@/lib/typography";
import {
  WikiTypeBadge,
  getWikiTypeIcon,
} from "@/components/wiki/WikiTypeBadge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Spinner } from "@/components/ui/spinner";
import {
  useExplorerFilters,
  EXPLORER_TYPES,
  type ExplorerType,
} from "@/hooks/useExplorerFilters";
import { useExplorerData, type ExplorerItem } from "@/hooks/useExplorerData";

const PAGE_SIZE = 50;

const TYPE_META: Record<ExplorerType, { icon: typeof FileCode; label: string }> = {
  fragment: { icon: FileCode, label: "Fragments" },
  wiki: { icon: MessageSquare, label: "Wikis" },
  person: { icon: UserRound, label: "People" },
  entry: { icon: NotebookText, label: "Entries" },
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function ExplorerInner() {
  const { filters, setFilter, clearFilters, hasActiveFilters } =
    useExplorerFilters();
  const { items, isLoading, isError, collections } = useExplorerData(filters);

  const [showFilters, setShowFilters] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filters.types.join(","), filters.collection, filters.sort]);

  // Infinite scroll
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const entry = entries[0];
      if (entry?.isIntersecting && visibleCount < items.length) {
        setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, items.length));
      }
    },
    [visibleCount, items.length],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );

  // Toggle a type in the filter array
  const toggleType = useCallback(
    (type: ExplorerType) => {
      const current = filters.types;
      if (current.includes(type)) {
        setFilter(
          "types",
          current.filter((t) => t !== type),
        );
      } else {
        setFilter("types", [...current, type]);
      }
    },
    [filters.types, setFilter],
  );

  return (
    <div className="wiki-page">
      <div className="wiki-page__content">
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
            marginBottom: 16,
          }}
        >
          <div>
            <h1 style={{ ...T.hero, margin: 0, color: "var(--wiki-title)" }}>
              Explorer
            </h1>
            <p
              style={{
                ...T.bodySmall,
                color: "var(--wiki-count)",
                margin: "4px 0 0",
              }}
            >
              {isLoading
                ? "Loading..."
                : `${items.length} objects${hasActiveFilters ? " (filtered)" : ""}`}
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative rounded-md"
            aria-label="Toggle filters"
            onClick={() => setShowFilters((prev) => !prev)}
          >
            <SlidersHorizontal className="size-4" strokeWidth={1.5} />
            {hasActiveFilters && (
              <span
                className="absolute -top-1 -right-1 block h-2.5 w-2.5 rounded-full bg-foreground"
                aria-hidden
              />
            )}
          </Button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div
            style={{
              borderTop: "1px solid var(--wiki-card-border)",
              padding: "16px 0 20px",
            }}
          >
            {/* Type filters */}
            <div style={{ marginBottom: 16 }}>
              <span
                style={{
                  ...T.micro,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--wiki-count)",
                  display: "block",
                  marginBottom: 8,
                }}
              >
                Type
              </span>
              <div className="flex flex-wrap items-start" style={{ gap: 8 }}>
                {EXPLORER_TYPES.map((type) => {
                  const meta = TYPE_META[type];
                  const Icon = meta.icon;
                  const isActive =
                    filters.types.length === 0 || filters.types.includes(type);
                  const isExplicit = filters.types.includes(type);

                  return (
                    <Chip
                      key={type}
                      icon={<Icon size={12} strokeWidth={1.5} />}
                      label={meta.label}
                      active={isActive}
                      onClick={() => toggleType(type)}
                    >
                      {isExplicit && (
                        <span
                          className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
                          aria-hidden
                        />
                      )}
                    </Chip>
                  );
                })}
              </div>
            </div>

            {/* Collection filters */}
            {collections.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <span
                  style={{
                    ...T.micro,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--wiki-count)",
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Collection
                </span>
                <div className="flex flex-wrap items-start" style={{ gap: 8 }}>
                  <Chip
                    label="All collections"
                    active={filters.collection === null}
                    onClick={() => setFilter("collection", null)}
                  />
                  {collections.map((collection) => (
                    <Chip
                      key={collection.id}
                      icon={
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{
                            backgroundColor:
                              collection.color || "var(--wiki-count)",
                          }}
                          aria-hidden
                        />
                      }
                      label={collection.name}
                      active={filters.collection === collection.id}
                      onClick={() =>
                        setFilter(
                          "collection",
                          filters.collection === collection.id ? null : collection.id,
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Sort filters */}
            <div style={{ marginBottom: 16 }}>
              <span
                style={{
                  ...T.micro,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--wiki-count)",
                  display: "block",
                  marginBottom: 8,
                }}
              >
                Sort
              </span>
              <div className="flex flex-wrap items-start" style={{ gap: 8 }}>
                {(
                  [
                    { value: "recent", label: "Recent" },
                    { value: "oldest", label: "Oldest" },
                    { value: "alpha", label: "A-Z" },
                  ] as const
                ).map(({ value, label }) => (
                  <Chip
                    key={value}
                    label={label}
                    active={filters.sort === value}
                    onClick={() => setFilter("sort", value)}
                  />
                ))}
              </div>
            </div>

            {/* Clear filters */}
            {hasActiveFilters && (
              <Chip
                icon={<X size={12} strokeWidth={1.5} />}
                label="Clear filters"
                onClick={clearFilters}
              />
            )}
          </div>
        )}

        {/* Object list */}
        {isLoading ? (
          <div className="flex w-full justify-center py-12">
            <Spinner className="size-5" />
          </div>
        ) : isError ? (
          <p
            style={{
              ...T.body,
              color: "var(--wiki-count)",
              padding: "24px 0",
            }}
          >
            Failed to load data. Please try again.
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              borderTop: "1px solid var(--wiki-card-border)",
            }}
          >
            {visibleItems.length === 0 ? (
              <li
                style={{
                  padding: "24px 4px",
                  color: "var(--wiki-count)",
                  ...T.body,
                }}
              >
                {hasActiveFilters ? (
                  <span>
                    No objects match your filters.{" "}
                    <button
                      type="button"
                      onClick={clearFilters}
                      style={{
                        color: "var(--wiki-link)",
                        textDecoration: "underline",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        font: "inherit",
                      }}
                    >
                      Clear filters
                    </button>
                  </span>
                ) : (
                  "No objects yet"
                )}
              </li>
            ) : (
              visibleItems.map((item) => (
                <ExplorerRow
                  key={item.id}
                  item={item}
                  activeCollectionId={filters.collection}
                />
              ))
            )}
          </ul>
        )}

        {/* Sentinel for infinite scroll */}
        {visibleCount < items.length && <div ref={sentinelRef} className="h-8" />}
      </div>
    </div>
  );
}

function ExplorerRow({
  item,
  activeCollectionId,
}: {
  item: ExplorerItem;
  activeCollectionId: string | null;
}) {
  const Icon = getWikiTypeIcon(item.subtype ?? item.type);
  // When a collection filter is active, prefer surfacing the matching one;
  // otherwise show the first membership.
  const surfacedCollection =
    (activeCollectionId
      ? item.collections.find((c) => c.id === activeCollectionId)
      : null) ?? item.collections[0] ?? null;

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 4px",
        borderBottom: "1px solid var(--wiki-card-border)",
      }}
    >
      {/* Left: icon + title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            color: "var(--wiki-count)",
            flexShrink: 0,
          }}
        >
          {Icon ? <Icon size={16} strokeWidth={1.5} /> : null}
        </span>
        <Link
          href={item.href}
          className="wiki-fragment-link"
          style={{
            ...T.body,
            fontFamily: FONT.SANS,
            color: "var(--wiki-fragment-link)",
            textDecoration: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {item.title}
        </Link>
      </div>

      {/* Right: badge + collection indicator + date */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexShrink: 0,
        }}
      >
        <WikiTypeBadge
          type={item.subtype ?? (item.type.charAt(0).toUpperCase() + item.type.slice(1))}
        />

        {surfacedCollection && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: surfacedCollection.color }}
              aria-hidden
            />
            <span
              className="hidden sm:inline"
              style={{ ...T.micro, color: "var(--wiki-count)" }}
            >
              {surfacedCollection.name}
            </span>
          </div>
        )}

        <span
          style={{
            ...T.bodySmall,
            fontFamily: FONT.SANS,
            color: "var(--wiki-count)",
            minWidth: 80,
            textAlign: "right",
          }}
        >
          {timeAgo(item.date)}
        </span>
      </div>
    </li>
  );
}

export default function ExplorerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex w-full justify-center py-12">
          <Spinner className="size-5" />
        </div>
      }
    >
      <ExplorerInner />
    </Suspense>
  );
}

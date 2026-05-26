'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useCollections } from '@/hooks/useCollections';
import { useWikis } from '@/hooks/useWikis';
import { ROUTES } from '@/lib/routes';
import { T } from '@/lib/typography';
import AddCollectionModal from '@/components/layout/AddCollectionModal';

interface GroupWiki {
  lookupKey: string;
  slug: string;
  name: string;
  type: string;
  fragmentCount: number;
}

function CollectionCard({
  id,
  name,
  color,
  wikiCount,
}: {
  id: string;
  name: string;
  color: string;
  wikiCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['group-wikis', id],
    queryFn: async () => {
      const r = await fetch(`/api/groups/${id}/wikis`, { credentials: 'include' });
      if (!r.ok) throw new Error('failed');
      const json = await r.json();
      const wikis = (json.wikis ?? []) as GroupWiki[];
      return wikis.sort((a, b) => b.fragmentCount - a.fragmentCount);
    },
    enabled: expanded,
    staleTime: 60_000,
  });

  return (
    <div
      style={{
        border: '1px solid var(--card-border)',
        borderRadius: 8,
        background: 'var(--bg)',
        overflow: 'hidden',
        transition: 'box-shadow 0.15s ease',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          borderLeft: `4px solid ${color}`,
        }}
      >
        <ChevronRight
          size={18}
          style={{
            color: 'var(--wiki-count)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 0.15s ease',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            ...T.h4,
            color: 'var(--heading-color)',
            flex: 1,
            fontWeight: 600,
          }}
        >
          {name}
        </span>
        <span
          style={{
            ...T.micro,
            color: 'var(--wiki-count)',
            background: 'var(--card-border)',
            padding: '3px 10px',
            borderRadius: 12,
            fontWeight: 500,
          }}
        >
          {wikiCount} wiki{wikiCount === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <div
          style={{
            padding: '4px 18px 14px 36px',
            borderTop: '1px solid var(--card-border)',
            background: 'var(--bg)',
          }}
        >
          {isLoading && (
            <p style={{ ...T.bodySmall, color: 'var(--wiki-count)', margin: '10px 0' }}>
              Loading…
            </p>
          )}
          {!isLoading && data && data.length === 0 && (
            <p style={{ ...T.bodySmall, color: 'var(--wiki-count)', margin: '10px 0' }}>
              No wikis in this collection.
            </p>
          )}
          {!isLoading && data && data.length > 0 && (
            <ul
              style={{
                margin: '8px 0 0',
                padding: 0,
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {data.map((w) => (
                <li key={w.lookupKey}>
                  <Link
                    href={ROUTES.wiki(w.lookupKey)}
                    style={{
                      ...T.bodySmall,
                      color: 'var(--wiki-link)',
                      textDecoration: 'none',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      padding: '4px 0',
                    }}
                  >
                    <span style={{ flex: 1 }}>{w.name}</span>
                    {w.fragmentCount > 0 && (
                      <span
                        style={{
                          ...T.micro,
                          color: 'var(--wiki-count)',
                          flexShrink: 0,
                        }}
                      >
                        {w.fragmentCount}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function UncategorisedCard() {
  const [expanded, setExpanded] = useState(false);
  const { data: wikiData, isLoading } = useWikis();
  const uncategorised = useMemo(() => {
    const all = wikiData?.wikis ?? [];
    return all.filter((w) => (w.collections ?? []).length === 0);
  }, [wikiData?.wikis]);

  if (isLoading || uncategorised.length === 0) return null;

  return (
    <div
      style={{
        border: '1px solid var(--card-border)',
        borderRadius: 8,
        background: 'var(--bg)',
        overflow: 'hidden',
        transition: 'box-shadow 0.15s ease',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          borderLeft: '4px solid var(--heading-secondary)',
        }}
      >
        <ChevronRight
          size={18}
          style={{
            color: 'var(--wiki-count)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 0.15s ease',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            ...T.h4,
            color: 'var(--heading-color)',
            flex: 1,
            fontWeight: 600,
          }}
        >
          Uncategorised Wikis
        </span>
        <span
          style={{
            ...T.micro,
            color: 'var(--wiki-count)',
            background: 'var(--card-border)',
            padding: '3px 10px',
            borderRadius: 12,
            fontWeight: 500,
          }}
        >
          {uncategorised.length} wiki{uncategorised.length === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <div
          style={{
            padding: '4px 18px 14px 36px',
            borderTop: '1px solid var(--card-border)',
            background: 'var(--bg)',
          }}
        >
          <ul
            style={{
              margin: '8px 0 0',
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {uncategorised.map((w) => (
              <li key={w.lookupKey}>
                <Link
                  href={ROUTES.wiki(w.lookupKey)}
                  style={{
                    ...T.bodySmall,
                    color: 'var(--wiki-link)',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    padding: '4px 0',
                  }}
                >
                  <span style={{ flex: 1 }}>{w.name}</span>
                  {typeof w.noteCount === 'number' && w.noteCount > 0 ? (
                    <span
                      style={{
                        ...T.micro,
                        color: 'var(--wiki-count)',
                        flexShrink: 0,
                      }}
                    >
                      {w.noteCount}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CollectionsHome() {
  const { data: collections, isLoading } = useCollections();
  const [addCollectionOpen, setAddCollectionOpen] = useState(false);

  if (isLoading) {
    return (
      <p style={{ ...T.bodySmall, color: 'var(--wiki-count)' }}>
        Loading collections…
      </p>
    );
  }

  // Empty state: the home page is organised entirely by collections, so a
  // workspace that has none has nothing to render. Explain what collections
  // do and offer a one-click path to create one. AddCollectionModal is the
  // same modal the header `+ New → Collection` menu opens.
  if (!collections || collections.length === 0) {
    return (
      <>
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 12,
            padding: '24px 0',
          }}
        >
          <p
            style={{
              ...T.bodySmall,
              color: 'var(--wiki-article-text)',
              margin: 0,
            }}
          >
            Add Collections to build your Wiki Homepage.
          </p>
          <p
            style={{
              ...T.micro,
              color: 'var(--wiki-count)',
              margin: 0,
              maxWidth: 540,
            }}
          >
            Collections group your wikis by theme. Once you create one, the
            homepage organises every wiki into its collection so you can
            browse from here.
          </p>
          <button
            type="button"
            onClick={() => setAddCollectionOpen(true)}
            style={{
              ...T.bodySmall,
              color: 'var(--wiki-link)',
              background: 'none',
              border: '1px solid var(--wiki-card-border)',
              padding: '6px 14px',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            + Add Collection
          </button>
        </section>
        <AddCollectionModal
          open={addCollectionOpen}
          onClose={() => setAddCollectionOpen(false)}
        />
      </>
    );
  }

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <h2
        style={{
          ...T.h3,
          color: 'var(--heading-color)',
          margin: '0 0 8px',
        }}
      >
        Browse by collection
      </h2>
      {collections.map((c) => (
        <CollectionCard
          key={c.id}
          id={c.id}
          name={c.name}
          color={c.color || 'var(--wiki-link)'}
          wikiCount={c.wikiCount}
        />
      ))}
      <UncategorisedCard />
    </section>
  );
}

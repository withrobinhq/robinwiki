import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  PublishedWikiArticle,
  type PublishedWikiData,
} from "./PublishedWikiArticle";

const API_BASE =
  process.env.NEXT_PUBLIC_ROBIN_API ?? "http://localhost:3000";

async function fetchPublishedWiki(
  nanoid: string,
): Promise<PublishedWikiData | null> {
  // Always revalidate publish-state on every request — the API is the source
  // of truth and sets `Cache-Control: no-store`. Caching here would let an
  // unpublished wiki keep rendering 200 until the cache window expires.
  const res = await fetch(`${API_BASE}/published/wiki/${nanoid}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ nanoid: string }>;
}): Promise<Metadata> {
  const { nanoid } = await params;
  const wiki = await fetchPublishedWiki(nanoid);
  if (!wiki) {
    return { title: "Not Found — Robin Wiki" };
  }

  const description = wiki.content.slice(0, 160).replace(/\n/g, " ");

  return {
    title: `${wiki.name} — Robin Wiki`,
    description,
    openGraph: {
      title: wiki.name,
      description,
      type: "article",
      publishedTime: wiki.publishedAt,
      siteName: "Robin Wiki",
    },
  };
}

export default async function PublishedWikiPage({
  params,
}: {
  params: Promise<{ nanoid: string }>;
}) {
  const { nanoid } = await params;
  const wiki = await fetchPublishedWiki(nanoid);
  if (!wiki) notFound();

  return <PublishedWikiArticle wiki={wiki} />;
}

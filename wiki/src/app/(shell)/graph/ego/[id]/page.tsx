import { EgoGraphPageClient } from "./EgoGraphPageClient";

/**
 * Ego graph deep-link route. Phase 1 keeps this page a thin server
 * shell: the client component owns data fetching via the existing
 * `/graph` endpoint and computes the ego subgraph in the browser.
 */
export default async function EgoGraphPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EgoGraphPageClient id={id} />;
}

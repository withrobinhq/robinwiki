/**
 * /wiki-management layout — transparent pass-through. Kept as its own
 * file so future cross-route concerns (Guardian role gating, shared
 * chrome) have a single mount point without touching every subroute
 * page.
 */
export default function WikiManagementLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}

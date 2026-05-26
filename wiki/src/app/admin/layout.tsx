/**
 * /admin layout — transparent pass-through. Kept as its own file so
 * future cross-route concerns (auth gating, role checks, shared
 * chrome) have a single mount point without touching every subroute
 * page.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}

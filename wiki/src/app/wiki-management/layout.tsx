import { redirect } from 'next/navigation'
import { IS_DEMO_MODE } from '@/lib/demo-mode'

/**
 * /wiki-management tree is hidden entirely in demo mode. Any GET to
 * /wiki-management or /wiki-management/* redirects home so the
 * Guardian-level surface is not addressable on a public deploy. The
 * backend separately blocks the underlying mutations via
 * demoWriteBlock — see core/src/middleware/session.ts.
 */
export default function WikiManagementLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (IS_DEMO_MODE) {
    redirect('/wiki')
  }
  return <>{children}</>
}

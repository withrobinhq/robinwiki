import { redirect } from 'next/navigation'
import { IS_DEMO_MODE } from '@/lib/demo-mode'

/**
 * /admin tree is hidden entirely in demo mode. Any GET to /admin or
 * /admin/* redirects home so the admin surface is not addressable on
 * a public deploy. The backend separately blocks the underlying
 * /admin/* mutations via demoWriteBlock — see
 * core/src/middleware/session.ts.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (IS_DEMO_MODE) {
    redirect('/wiki')
  }
  return <>{children}</>
}

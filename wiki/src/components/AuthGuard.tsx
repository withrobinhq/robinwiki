'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { useSession } from '@/hooks/useSession'
import { useProfile } from '@/hooks/useProfile'

const RESET_PATH = '/account/initial-password-reset'

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { session, isAuthenticated, isLoading } = useSession()
  const { data: profile, isLoading: profileLoading } = useProfile({
    enabled: isAuthenticated,
  })

  const isPublicPath = pathname === '/login' || pathname === '/recover'
  const isResetPath = pathname === RESET_PATH
  // mustResetPassword flows through better-auth's user.additionalFields
  // (mapped to users.password_reset_required). The field is not in the
  // generated Session type yet, so widen the user object to read it.
  const mustResetPassword =
    (session?.user as { mustResetPassword?: boolean } | undefined)
      ?.mustResetPassword === true

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicPath) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, isPublicPath, router])

  // Force-reset gate (#71). Runs above the onboarding redirect so a freshly
  // provisioned user lands on the password-reset page before anything else.
  // No deep-link bypass: every protected path falls through to RESET_PATH
  // until /users/clear-reset-flag flips the flag.
  useEffect(() => {
    if (
      isAuthenticated &&
      mustResetPassword &&
      !isPublicPath &&
      !isResetPath
    ) {
      router.replace(RESET_PATH)
    }
  }, [isAuthenticated, mustResetPassword, isPublicPath, isResetPath, router])

  // Redirect authenticated but un-onboarded users to onboarding wizard
  useEffect(() => {
    if (
      isAuthenticated &&
      !mustResetPassword &&
      !profileLoading &&
      !profile?.onboardedAt &&
      !isPublicPath
    ) {
      router.replace('/')
    }
  }, [
    isAuthenticated,
    mustResetPassword,
    profileLoading,
    profile,
    isPublicPath,
    router,
  ])

  if (isLoading) return null
  if (!isAuthenticated && !isPublicPath) return null
  if (isAuthenticated && mustResetPassword && !isResetPath && !isPublicPath)
    return null
  if (isAuthenticated && profileLoading) return null
  if (
    isAuthenticated &&
    !mustResetPassword &&
    !profile?.onboardedAt &&
    !isPublicPath
  )
    return null

  return <>{children}</>
}

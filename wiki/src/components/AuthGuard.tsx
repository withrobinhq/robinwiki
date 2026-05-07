'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { useSession } from '@/hooks/useSession'
import { useProfile } from '@/hooks/useProfile'

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { isAuthenticated, isLoading } = useSession()
  const { data: profile, isLoading: profileLoading } = useProfile({
    enabled: isAuthenticated,
  })

  const isPublicPath = pathname === '/login' || pathname === '/recover'

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicPath) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, isPublicPath, router])

  // Redirect authenticated but un-onboarded users to the onboarding wizard at `/`
  useEffect(() => {
    if (
      isAuthenticated &&
      !profileLoading &&
      !profile?.onboardedAt &&
      !isPublicPath
    ) {
      router.replace('/')
    }
  }, [isAuthenticated, profileLoading, profile, isPublicPath, router])

  if (isLoading) return null
  if (!isAuthenticated && !isPublicPath) return null
  if (isAuthenticated && profileLoading) return null
  if (
    isAuthenticated &&
    !profile?.onboardedAt &&
    !isPublicPath
  )
    return null

  return <>{children}</>
}

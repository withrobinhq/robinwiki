'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { useSession } from '@/hooks/useSession'
import { T, FONT } from '@/lib/typography'
import { Spinner } from '@/components/ui/spinner'

export default function LoginPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace('/')
    }
  }, [isLoading, isAuthenticated, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      })
      if (signInError) {
        setError(signInError.message ?? 'Sign in failed')
        setLoading(false)
        return
      }
      // Don't navigate here — better-auth's session atom refreshes
      // asynchronously (10ms after sign-in). If we router.push('/')
      // immediately, the home page sees stale isAuthenticated=false
      // and bounces back to /login. Instead, keep the spinner visible
      // and let the useEffect above redirect once useSession() reflects
      // the new session.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
      setLoading(false)
    }
  }

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Spinner className="size-5" />
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg)',
        fontFamily: FONT.SANS,
      }}
    >
      <div style={{ width: '100%', maxWidth: 360 }}>
        <h1
          style={{
            ...T.h1,
            fontFamily: FONT.SERIF,
            textAlign: 'center',
            marginBottom: 8,
            color: 'var(--heading-color)',
          }}
        >
          Sign in
        </h1>
        <p
          style={{
            ...T.bodySmall,
            textAlign: 'center',
            color: 'var(--heading-secondary)',
            marginBottom: 32,
          }}
        >
          Your personal knowledge base
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label
              htmlFor="email"
              style={{
                ...T.label,
                color: 'var(--input-label)',
              }}
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              style={{
                ...T.input,
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--input-border)',
                borderRadius: 2,
                background: 'transparent',
                color: 'var(--heading-color)',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label
              htmlFor="password"
              style={{
                ...T.label,
                color: 'var(--input-label)',
              }}
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                ...T.input,
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--input-border)',
                borderRadius: 2,
                background: 'transparent',
                color: 'var(--heading-color)',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
          </div>

          {error && (
            <p
              style={{
                ...T.bodySmall,
                color: 'var(--destructive)',
                margin: 0,
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              ...T.button,
              width: '100%',
              padding: '10px 0',
              background: 'var(--btn-primary-bg)',
              color: 'var(--btn-primary-text)',
              border: 'none',
              borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {/* No /recover affordance here by design. Recovery is a documentation
            primitive: operators reach `/recover` directly with the deploy-side
            RECOVERY_SECRET. Surfacing a "Forgot password?" link in a single-
            tenant tool would imply a self-serve flow we don't run. */}
      </div>
    </div>
  )
}

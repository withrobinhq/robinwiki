# Deploy notes

## Reverse-proxy / XFF trust

The `/auth/recover` rate limiter keys on `x-forwarded-for` (the leftmost
entry). It REQUIRES a trusted reverse proxy in front of the Robin server
that strips or overwrites incoming `X-Forwarded-For` headers before
forwarding — otherwise an attacker can rotate XFF per-request and defeat
the per-IP budget. Railway's gateway does this; bare-metal deployments
must terminate at nginx/Caddy/Cloudflare with header rewriting enabled.

Rate-limiter state lives in Redis at:

- `rl:recover:<ip>:m:<minute>` (TTL 65s)
- `rl:recover:<ip>:d:<day>` (TTL 86460s)

Buckets: 5/min and 60/day per IP. Redis outage fails closed (HTTP 503
on `/auth/recover`).

## Cookie security boot gate

When `NODE_ENV=production` the server refuses to start unless
`SERVER_PUBLIC_URL` begins with `https://`. Cookie security flags
(`useSecureCookies`, `Secure`, `SameSite=None`) derive from `NODE_ENV`
alone — see `core/src/auth.ts` and `core/src/bootstrap/env.ts`.

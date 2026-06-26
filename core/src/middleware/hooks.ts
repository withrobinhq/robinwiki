import type { Context, Next } from 'hono';

// These are our default "No-op" implementations
export const defaultResolveOrg = async (c: Context, next: Next) => {
  // Default: pass through, no org resolution
  await next();
};

export const defaultCheckPermission = async (c: Context, next: Next) => {
  // Default: pass through, no permission check
  await next();
};

// These can be replaced at app startup by the enterprise plugin
export let resolveOrgMiddleware = defaultResolveOrg;
export let checkPermissionMiddleware = defaultCheckPermission;

// Helper for the enterprise repo to override the defaults
export function overrideMiddleware(
  slot: 'resolveOrg' | 'checkPermission',
  impl: (c: Context, next: Next) => Promise<void>
) {
  if (slot === 'resolveOrg') resolveOrgMiddleware = impl;
  if (slot === 'checkPermission') checkPermissionMiddleware = impl;
}

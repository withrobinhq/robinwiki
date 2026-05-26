export const ROUTES = {
  home: '/wiki',
  login: '/login',
  recover: '/recover',
  profile: '/profile',
  wikiManagement: '/wiki-management',
  admin: '/admin',
  wikiTypes: '/admin/wiki-types',
  wikiTypeEditor: (slug: string) => `/admin/wiki-types/${slug}`,
  explorer: '/explorer',
  graph: '/graph',
  search: '/search',
  wiki: (id: string) => `/wiki/${id}`,
  fragment: (id: string) => `/fragments/${id}`,
  person: (id: string) => `/people/${id}`,
  entry: (id: string) => `/entries/${id}`,
} as const

export const PUBLIC_PATHS = ['/login', '/recover'] as const

export function refToHref(ref: { kind: string; id: string }): string {
  switch (ref.kind) {
    case 'person':   return ROUTES.person(ref.id)
    case 'fragment': return ROUTES.fragment(ref.id)
    case 'entry':    return ROUTES.entry(ref.id)
    case 'wiki':
    default:         return ROUTES.wiki(ref.id)
  }
}

import { monotonicFactory } from 'ulidx'

export const ObjectType = {
  ENTRY: 'entry',
  FRAGMENT: 'frag',
  WIKI: 'wiki',
  PERSON: 'person',
} as const

export type ObjectType = (typeof ObjectType)[keyof typeof ObjectType]

/** Map type prefix to directory name */
export const TYPE_TO_DIR: Record<ObjectType, string> = {
  entry: 'entries',
  frag: 'fragments',
  wiki: 'wikis',
  person: 'people',
}

/**
 * @summary Unanchored regex patterns for matching lookup keys by type.
 *
 * @remarks
 * Canonical format: `{prefix}[0-9A-Z]{26}` (Crockford Base32 ULID, no separator).
 * Use these for substring extraction from unstructured text (e.g. MCP
 * response bodies, log lines). For trust-boundary validation of a single
 * input string, use {@link LK_REGEX_STRICT} instead — the unanchored form
 * happily matches a valid key embedded in a malicious envelope (e.g.
 * `https://evil.com/wiki01...`).
 *
 * @example
 * ```ts
 * const match = text.match(LK_REGEX.entry)
 * // match[0] === 'entry01KMJBYN40EK57JDH4RXWNKETV'
 * ```
 */
export const LK_REGEX: Record<ObjectType, RegExp> = {
  entry: /entry[0-9A-Z]{26}/,
  frag: /frag[0-9A-Z]{26}/,
  wiki: /wiki[0-9A-Z]{26}/,
  person: /person[0-9A-Z]{26}/,
}

/**
 * @summary Anchored variant of {@link LK_REGEX} — for strict-match
 * validation at trust boundaries (e.g. router.push, DB key writes).
 *
 * @remarks
 * Unlike {@link LK_REGEX}, this set rejects strings that merely *contain*
 * a valid key. Use it whenever an unsanitised string is about to become a
 * route, file path, or DB primary key. (#audit-M9)
 */
export const LK_REGEX_STRICT: Record<ObjectType, RegExp> = {
  entry: /^entry[0-9A-Z]{26}$/,
  frag: /^frag[0-9A-Z]{26}$/,
  wiki: /^wiki[0-9A-Z]{26}$/,
  person: /^person[0-9A-Z]{26}$/,
}

/** Match any lookup key regardless of type (unanchored substring form). */
export const ANY_LOOKUP_KEY_RE = /(?:entry|frag|wiki|person)[0-9A-Z]{26}/

/** Map type prefix to canonical wiki path. */
const PREFIX_TO_PATH: Record<ObjectType, (id: string) => string> = {
  entry: (id) => `/entries/${id}`,
  frag: (id) => `/fragments/${id}`,
  wiki: (id) => `/wiki/${id}`,
  person: (id) => `/people/${id}`,
}

/**
 * Validate a lookup-key ref against {@link LK_REGEX_STRICT} and return the
 * canonical wiki path on match, or null on mismatch.
 *
 * Use at any trust boundary that turns an unsanitised string into a
 * client-side route (e.g. `router.push`). The strict regex prevents
 * absolute URLs, scheme-relative URLs, and arbitrary path segments from
 * leaking into navigation. (#audit-M9)
 *
 * @example
 * ```ts
 * safeRefToHref('wiki01ARZ3NDEKTSV4RRFFQ69G5FAV') // '/wiki/wiki01ARZ3NDEKTSV4RRFFQ69G5FAV'
 * safeRefToHref('https://evil.com')               // null
 * safeRefToHref('https://evil.com/wiki01ARZ...')  // null
 * ```
 */
export function safeRefToHref(ref: string): string | null {
  for (const prefix of Object.values(ObjectType)) {
    if (LK_REGEX_STRICT[prefix].test(ref)) {
      return PREFIX_TO_PATH[prefix](ref)
    }
  }
  return null
}

/**
 * Monotonic ULID factory. Use for any ephemeral or transient ID that
 * needs to be unique and time-ordered (React keys, in-memory revision
 * records, request correlation ids, etc.). For persisted objects with
 * a known ObjectType, prefer `makeLookupKey(type)` which produces a
 * type-prefixed key.
 */
export const generateUlid = monotonicFactory()

/** Generate a type-prefixed lookup key, e.g. "frag01HZY3Q9R3..." */
export function makeLookupKey(type: ObjectType): string {
  return `${type}${generateUlid()}`
}

/** Extract the type prefix and raw ULID from a lookup key */
export function parseLookupKey(key: string): { type: ObjectType; ulid: string } {
  for (const prefix of Object.values(ObjectType)) {
    if (key.startsWith(prefix)) {
      return { type: prefix, ulid: key.slice(prefix.length) }
    }
  }
  throw new Error(`Unknown type prefix in key: ${key}`)
}

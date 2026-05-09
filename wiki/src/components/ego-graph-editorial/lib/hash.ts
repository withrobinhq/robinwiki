/**
 * Deterministic 32-bit FNV-1a hash. Used by the ring layout to
 * derive stable jitter for angle and radius without pulling in a
 * Math.random seed. Same input always produces the same output, so
 * node positions are consistent across renders.
 */
export function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h;
}

/** Seeded randomness: everything random is keyed by (seed, boil step, key) so preview and export match. */

export interface Rng {
  next(): number
  range(a: number, b: number): number
  int(a: number, b: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
  /** Roughly normal, mean 0, sd 1. */
  gauss(): number
  sign(): number
}

export function hash(...parts: (number | string)[]): number {
  let h = 2166136261 >>> 0
  for (const p of parts) {
    const s = typeof p === 'number' ? String(Math.round(p * 1000)) : p
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= 0x9e3779b9
    h = Math.imul(h ^ (h >>> 15), 2246822507)
  }
  return h >>> 0
}

export function rng(...parts: (number | string)[]): Rng {
  let a = hash(...parts) || 1
  const next = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    chance: (p) => next() < p,
    gauss: () => (next() + next() + next() + next() - 2) * 1.7320508,
    sign: () => (next() < 0.5 ? -1 : 1)
  }
}

/** Smooth 2D value noise in [-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const v = (a: number, b: number): number => (hash(seed, a, b) / 4294967296) * 2 - 1
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = v(ix, iy)
  const b = v(ix + 1, iy)
  const c = v(ix, iy + 1)
  const d = v(ix + 1, iy + 1)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Smooth 1D value noise in [-1, 1], deterministic per seed. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = (hash(seed, i) / 4294967296) * 2 - 1
  const b = (hash(seed, i + 1) / 4294967296) * 2 - 1
  const s = f * f * (3 - 2 * f)
  return a + (b - a) * s
}

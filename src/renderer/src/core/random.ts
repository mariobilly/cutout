import type { RandRule } from '../styles/types'

/**
 * Randomize params from curated rules. amount = 1 rolls everything fresh; amount < 1 nudges numbers by that
 * share of their range and swaps choices with probability amount / 2 (a variation on the current look).
 */
export function randomize(p: Record<string, unknown>, rules: Record<string, RandRule | undefined>, amount = 1): void {
  for (const [key, rule] of Object.entries(rules)) {
    if (!rule) continue
    if ('pick' in rule) {
      if (amount >= 1 || Math.random() < amount / 2) p[key] = rule.pick[Math.floor(Math.random() * rule.pick.length)]
      continue
    }
    const span = rule.max - rule.min
    let v: number
    if (amount >= 1) v = rule.min + Math.random() * span
    else {
      const cur = typeof p[key] === 'number' ? (p[key] as number) : rule.min + span / 2
      v = cur + (Math.random() * 2 - 1) * span * amount
    }
    v = Math.min(rule.max, Math.max(rule.min, v))
    p[key] = rule.int ? Math.round(v) : Math.round(v * 100) / 100
  }
}

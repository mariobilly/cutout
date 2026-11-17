import { contours } from 'd3-contour'
import simplify from 'simplify-js'
import type { MaskData } from '../vision/Vision'
import { noise2, type Rng } from './rng'

export type Pt = [number, number]
export type Ring = Pt[]

/** A connected region of the mask (mask pixel space). */
export interface Blob {
  label: number
  area: number
  cx: number
  cy: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One tracked subject, outlines in output pixels. `rings` holds outers and holes (draw with evenodd). */
export interface Shape {
  id: number
  rings: Ring[]
  cx: number
  cy: number
  /** Fraction of the frame the subject covers. */
  cover: number
  x0: number
  y0: number
  x1: number
  y1: number
}

// ---------- mask clean-up ----------

/** Exponential moving average over frames: steadies the edge without lagging much. */
export class MaskSmoother {
  private acc: Float32Array | null = null
  private w = 0
  private h = 0

  reset(): void {
    this.acc = null
  }

  apply(m: MaskData, amount: number): MaskData {
    if (amount <= 0 || !this.acc || this.w !== m.w || this.h !== m.h) {
      this.acc = Float32Array.from(m.data)
      this.w = m.w
      this.h = m.h
      return m
    }
    const a = this.acc
    const k = Math.min(0.92, amount)
    const out = new Uint8Array(m.data.length)
    for (let i = 0; i < a.length; i++) {
      a[i] = a[i] * k + m.data[i] * (1 - k)
      out[i] = a[i]
    }
    return { w: m.w, h: m.h, data: out }
  }
}

/** Separable box blur (radius r) of an 8-bit mask. */
export function boxBlur(m: MaskData, r: number): MaskData {
  if (r < 1) return m
  const { w, h, data } = m
  const tmp = new Uint8Array(data.length)
  const out = new Uint8Array(data.length)
  const d = r * 2 + 1
  for (let y = 0; y < h; y++) {
    let s = 0
    const row = y * w
    for (let x = -r; x <= r; x++) s += data[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / d
      s += data[row + Math.min(w - 1, x + r + 1)] - data[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / d
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return { w, h, data: out }
}

// ---------- connected components + stable ids ----------

export function labelComponents(m: MaskData, thr: number, minArea: number): { labels: Int32Array; blobs: Blob[] } {
  const { w, h, data } = m
  const t = thr * 255
  const labels = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const blobs: Blob[] = []
  let n = 0
  for (let start = 0; start < data.length; start++) {
    if (data[start] < t || labels[start]) continue
    n++
    let sp = 0
    stack[sp++] = start
    labels[start] = n
    let area = 0
    let sx = 0
    let sy = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    while (sp) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      area++
      sx += x
      sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && !labels[i - 1] && data[i - 1] >= t) (labels[i - 1] = n), (stack[sp++] = i - 1)
      if (x < w - 1 && !labels[i + 1] && data[i + 1] >= t) (labels[i + 1] = n), (stack[sp++] = i + 1)
      if (y > 0 && !labels[i - w] && data[i - w] >= t) (labels[i - w] = n), (stack[sp++] = i - w)
      if (y < h - 1 && !labels[i + w] && data[i + w] >= t) (labels[i + w] = n), (stack[sp++] = i + w)
    }
    if (area >= minArea) blobs.push({ label: n, area, cx: sx / area, cy: sy / area, x0, y0, x1, y1 })
  }
  return { labels, blobs }
}

/** Keeps subject ids (A, B, C…) stable across frames by matching centroids. */
export class IdTracker {
  private prev: { id: number; cx: number; cy: number }[] = []

  reset(): void {
    this.prev = []
  }

  assign(blobs: Blob[], w: number, h: number): Map<number, number> {
    const diag = Math.hypot(w, h)
    const pairs: { b: Blob; p: { id: number; cx: number; cy: number }; d: number }[] = []
    for (const b of blobs) for (const p of this.prev) pairs.push({ b, p, d: Math.hypot(b.cx / w - p.cx, b.cy / h - p.cy) })
    pairs.sort((a, b) => a.d - b.d)
    const ids = new Map<number, number>()
    const used = new Set<number>()
    for (const { b, p, d } of pairs) {
      if (d > 0.25 * (diag / Math.max(w, h)) || ids.has(b.label) || used.has(p.id)) continue
      ids.set(b.label, p.id)
      used.add(p.id)
    }
    // New subjects get the lowest free ids, left to right.
    const fresh = blobs.filter((b) => !ids.has(b.label)).sort((a, b) => a.cx - b.cx)
    let next = 0
    for (const b of fresh) {
      while (used.has(next)) next++
      ids.set(b.label, next)
      used.add(next)
    }
    this.prev = blobs.map((b) => ({ id: ids.get(b.label)!, cx: b.cx / w, cy: b.cy / h }))
    return ids
  }
}

/**
 * The point deepest inside a component (chamfer distance transform over its bbox): where a label sits
 * naturally, never in a hole or outside a C-shaped body.
 */
export function innerPoint(m: MaskData, labels: Int32Array, b: Blob): { x: number; y: number } {
  const { w } = m
  const bw = b.x1 - b.x0 + 3
  const bh = b.y1 - b.y0 + 3
  const d = new Float32Array(bw * bh)
  const INF = 1e9
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const sx = b.x0 + x - 1
      const sy = b.y0 + y - 1
      const inside = x > 0 && y > 0 && x < bw - 1 && y < bh - 1 && labels[sy * w + sx] === b.label
      d[y * bw + x] = inside ? INF : 0
    }
  for (let y = 1; y < bh; y++)
    for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i - 1] + 3, d[i - bw] + 3, d[i - bw - 1] + 4, d[i - bw + 1] + 4)
    }
  let best = 0
  let bx = b.cx
  let by = b.cy
  for (let y = bh - 2; y >= 0; y--)
    for (let x = bw - 2; x >= 1; x--) {
      const i = y * bw + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i + 1] + 3, d[i + bw] + 3, d[i + bw + 1] + 4, d[i + bw - 1] + 4)
      // Slight pull toward the centroid so wide torsos keep the label centered.
      const score = d[i] - Math.hypot(b.x0 + x - 1 - b.cx, b.y0 + y - 1 - b.cy) * 0.35
      if (score > best) {
        best = score
        bx = b.x0 + x - 1
        by = b.y0 + y - 1
      }
    }
  return { x: bx, y: by }
}

// ---------- tracing ----------

/** Outline of one component in mask pixel space, using the soft confidence edge (marching squares). */
export function traceBlob(m: MaskData, labels: Int32Array, b: Blob, thr: number): Ring[] {
  const { w, h, data } = m
  const pad = 2
  const x0 = Math.max(0, b.x0 - pad)
  const y0 = Math.max(0, b.y0 - pad)
  const x1 = Math.min(w - 1, b.x1 + pad)
  const y1 = Math.min(h - 1, b.y1 + pad)
  const cw = x1 - x0 + 1
  const ch = y1 - y0 + 1
  // One-cell zero border so rings touching the frame edge still close.
  const gw = cw + 2
  const gh = ch + 2
  const vals = new Float64Array(gw * gh)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y0 + y) * w + x0 + x
      const l = labels[i]
      vals[(y + 1) * gw + x + 1] = l === b.label || l === 0 ? data[i] / 255 : 0
    }
  }
  const [mp] = contours()
    .size([gw, gh])
    .thresholds([thr])(vals as unknown as number[])
  const rings: Ring[] = []
  for (const poly of mp.coordinates) {
    for (const ring of poly) {
      if (ring.length < 4) continue
      const r: Ring = ring.slice(0, -1).map(([x, y]) => [x + x0 - 1, y + y0 - 1])
      if (Math.abs(ringArea(r)) < 6) continue
      rings.push(r)
    }
  }
  return rings
}

// ---------- ring geometry ----------

export function ringArea(r: Ring): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1])
  return a / 2
}

export function ringBounds(rings: Ring[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  return { x0, y0, x1, y1 }
}

export function simplifyRing(r: Ring, tol: number): Ring {
  if (tol <= 0 || r.length < 8) return r
  const out = simplify(
    r.map(([x, y]) => ({ x, y })),
    tol,
    true
  ).map((p) => [p.x, p.y] as Pt)
  return out.length >= 3 ? out : r
}

/** Corner cutting on a closed ring. */
export function chaikin(r: Ring, iters: number): Ring {
  let cur = r
  for (let k = 0; k < iters; k++) {
    const next: Ring = []
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i]
      const b = cur[(i + 1) % cur.length]
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    cur = next
  }
  return cur
}

export function perimeter(r: Ring): number {
  let p = 0
  for (let i = 0; i < r.length; i++) {
    const a = r[i]
    const b = r[(i + 1) % r.length]
    p += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return p
}

/** Evenly spaced points along a closed ring. */
export function resample(r: Ring, spacing: number): Ring {
  const total = perimeter(r)
  const n = Math.max(6, Math.round(total / Math.max(1, spacing)))
  const step = total / n
  const out: Ring = []
  let seg = 0
  let segStart = 0
  let a = r[0]
  let b = r[1 % r.length]
  let segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
  for (let k = 0; k < n; k++) {
    const d = k * step
    while (d > segStart + segLen && seg < r.length) {
      segStart += segLen
      seg++
      a = r[seg % r.length]
      b = r[(seg + 1) % r.length]
      segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    const f = segLen > 0 ? (d - segStart) / segLen : 0
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

export function jitterRing(r: Ring, amp: number, g: Rng): Ring {
  if (amp <= 0) return r
  return r.map(([x, y]) => [x + g.range(-amp, amp), y + g.range(-amp, amp)])
}

/** Displace points by a noise field fixed in screen space: rough edges that don't shimmer while still. */
export function roughen(r: Ring, amp: number, seed: number, cell: number): Ring {
  if (amp <= 0) return r
  return r.map(([x, y]) => [x + noise2(seed, x / cell, y / cell) * amp, y + noise2(seed + 17, x / cell, y / cell) * amp])
}

/** Push each point along its outward normal by d (negative = inward). */
export function offsetRing(r: Ring, d: number): Ring {
  const sgn = ringArea(r) > 0 ? -1 : 1
  const n = r.length
  return r.map(([x, y], i) => {
    const p = r[(i - 1 + n) % n]
    const q = r[(i + 1) % n]
    let nx = q[1] - p[1]
    let ny = -(q[0] - p[0])
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    return [x + nx * d * sgn, y + ny * d * sgn]
  })
}

export function tracePath(ctx: CanvasRenderingContext2D | Path2D, rings: Ring[]): void {
  for (const r of rings) {
    if (r.length < 3) continue
    ctx.moveTo(r[0][0], r[0][1])
    for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1])
    ctx.closePath()
  }
}

/** Closed smooth curve through the points (quadratic midpoints): reads as hand-cut rather than polygonal. */
export function traceSmooth(ctx: CanvasRenderingContext2D | Path2D, rings: Ring[]): void {
  for (const r of rings) {
    const n = r.length
    if (n < 3) continue
    const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const m0 = mid(r[n - 1], r[0])
    ctx.moveTo(m0[0], m0[1])
    for (let i = 0; i < n; i++) {
      const m = mid(r[i], r[(i + 1) % n])
      ctx.quadraticCurveTo(r[i][0], r[i][1], m[0], m[1])
    }
    ctx.closePath()
  }
}

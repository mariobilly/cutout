import { rng, noise1, type Rng } from './rng'
import type { Pt, Ring } from './mask'

/** Procedural analog materials: paper, grain, torn edges, tape, ink, charcoal, scribbles, scratches. */

type Ctx = CanvasRenderingContext2D

export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Tileable value noise on a size×size grid with `cells` cells per side. */
function tileNoise(size: number, cells: number, g: Rng): Float32Array {
  const grid = new Float32Array(cells * cells).map(() => g.next())
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells
    const iy = Math.floor(fy)
    const ty = fy - iy
    const sy = ty * ty * (3 - 2 * ty)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells
      const ix = Math.floor(fx)
      const tx = fx - ix
      const sx = tx * tx * (3 - 2 * tx)
      const a = grid[(iy % cells) * cells + (ix % cells)]
      const b = grid[(iy % cells) * cells + ((ix + 1) % cells)]
      const c = grid[((iy + 1) % cells) * cells + (ix % cells)]
      const d = grid[((iy + 1) % cells) * cells + ((ix + 1) % cells)]
      out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
    }
  }
  return out
}

const paperCache = new Map<string, HTMLCanvasElement>()

/** A seamless 512 px paper tile: tone + soft blotches + fibers + specks. */
export function paperTile(tone: string, seed = 7): HTMLCanvasElement {
  const key = `${tone}|${seed}`
  const hit = paperCache.get(key)
  if (hit) return hit
  const S = 512
  const g = rng('paper', seed)
  const n1 = tileNoise(S, 4, g)
  const n2 = tileNoise(S, 16, g)
  const n3 = tileNoise(S, 64, g)
  const [r, gg, b] = hexRgb(tone)
  const c = canvas(S, S)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(S, S)
  for (let i = 0; i < S * S; i++) {
    const v = (n1[i] - 0.5) * 14 + (n2[i] - 0.5) * 8 + (n3[i] - 0.5) * 6 + (g.next() - 0.5) * 7
    img.data[i * 4] = r + v
    img.data[i * 4 + 1] = gg + v
    img.data[i * 4 + 2] = b + v * 1.1
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  // Fibers: short curved hairlines, light and dark, wrapped so the tile stays seamless.
  ctx.lineCap = 'round'
  for (let k = 0; k < 420; k++) {
    const x = g.range(0, S)
    const y = g.range(0, S)
    const a = g.range(0, Math.PI * 2)
    const len = g.range(4, 26)
    ctx.strokeStyle = g.chance(0.6) ? `rgba(0,0,0,${g.range(0.03, 0.08)})` : `rgba(255,255,255,${g.range(0.08, 0.2)})`
    ctx.lineWidth = g.range(0.4, 1.1)
    for (const [ox, oy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      ctx.beginPath()
      ctx.moveTo(x + ox, y + oy)
      ctx.quadraticCurveTo(x + ox + Math.cos(a + 0.6) * len * 0.5, y + oy + Math.sin(a + 0.6) * len * 0.5, x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len)
      ctx.stroke()
    }
  }
  for (let k = 0; k < 160; k++) {
    ctx.fillStyle = `rgba(40,30,20,${g.range(0.05, 0.25)})`
    ctx.beginPath()
    ctx.arc(g.range(0, S), g.range(0, S), g.range(0.3, 1.2), 0, Math.PI * 2)
    ctx.fill()
  }
  paperCache.set(key, c)
  return c
}

let grainTiles: HTMLCanvasElement[] | null = null

/** Four 256 px mid-gray noise tiles; drawn with 'overlay' they add film/print grain. */
export function grain(i: number): HTMLCanvasElement {
  if (!grainTiles) {
    grainTiles = [0, 1, 2, 3].map((k) => {
      const S = 256
      const g = rng('grain', k)
      const c = canvas(S, S)
      const ctx = c.getContext('2d')!
      const img = ctx.createImageData(S, S)
      for (let p = 0; p < S * S; p++) {
        const v = 128 + g.gauss() * 34
        img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v
        img.data[p * 4 + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      return c
    })
  }
  return grainTiles[((i % 4) + 4) % 4]
}

/** Fill the rect with a paper pattern (tile scaled with the frame so preview == export). */
export function fillPaper(ctx: Ctx, tone: string, x: number, y: number, w: number, h: number, u: number, seed = 7): void {
  const pat = ctx.createPattern(paperTile(tone, seed), 'repeat')!
  pat.setTransform(new DOMMatrix().scale(u * 1.2))
  ctx.fillStyle = pat
  ctx.fillRect(x, y, w, h)
}

// ---------- torn edges ----------

export function rectRing(cx: number, cy: number, w: number, h: number, angle = 0): Ring {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2]
  ].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as Pt)
}

/** Replace straight edges by a ragged torn line: fractal displacement perpendicular to each edge. */
export function tear(r: Ring, g: Rng, amp: number, step: number, edges?: boolean[]): Ring {
  const out: Ring = []
  for (let i = 0; i < r.length; i++) {
    const a = r[i]
    const b = r[(i + 1) % r.length]
    out.push(a)
    if (edges && !edges[i]) continue
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.floor(len / step))
    const nx = -(b[1] - a[1]) / (len || 1)
    const ny = (b[0] - a[0]) / (len || 1)
    const seed = g.int(0, 1e6)
    for (let k = 1; k < n; k++) {
      const f = k / n
      const d =
        (noise1(seed, k * 0.35) * 0.65 + noise1(seed + 1, k * 1.3) * 0.25 + g.range(-0.5, 0.5) * 0.25) * amp * Math.min(1, Math.min(f, 1 - f) * 8)
      out.push([a[0] + (b[0] - a[0]) * f + nx * d, a[1] + (b[1] - a[1]) * f + ny * d])
    }
  }
  return out
}

export function ringPath(r: Ring): Path2D {
  const p = new Path2D()
  p.moveTo(r[0][0], r[0][1])
  for (let i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1])
  p.closePath()
  return p
}

// ---------- tape ----------

export function tape(ctx: Ctx, g: Rng, cx: number, cy: number, len: number, wid: number, angle: number, color = '#b59c78', alpha = 0.86): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  // Zig-zag cut ends, straight long sides.
  const r: Ring = []
  const teeth = 6
  for (let k = 0; k <= teeth; k++) r.push([-len / 2 + (k % 2 ? g.range(2, 6) : 0) * (wid / 40), -wid / 2 + (wid * k) / teeth])
  for (let k = 0; k <= teeth; k++) r.push([len / 2 - (k % 2 ? g.range(2, 6) : 0) * (wid / 40), wid / 2 - (wid * k) / teeth])
  const p = ringPath(r)
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.shadowColor = 'rgba(0,0,0,0.18)'
  ctx.shadowBlur = wid * 0.12
  ctx.shadowOffsetY = wid * 0.04
  ctx.fill(p)
  ctx.shadowColor = 'transparent'
  ctx.clip(p)
  // Crepe texture: faint lengthwise streaks and creases.
  ctx.globalAlpha = 1
  for (let k = 0; k < 26; k++) {
    const y = g.range(-wid / 2, wid / 2)
    ctx.strokeStyle = g.chance(0.5) ? `rgba(255,255,255,${g.range(0.05, 0.16)})` : `rgba(60,40,20,${g.range(0.04, 0.12)})`
    ctx.lineWidth = g.range(0.5, wid * 0.06)
    ctx.beginPath()
    ctx.moveTo(-len / 2, y)
    ctx.lineTo(len / 2, y + g.range(-wid * 0.08, wid * 0.08))
    ctx.stroke()
  }
  for (let k = 0; k < 3; k++) {
    const x = g.range(-len / 2, len / 2)
    ctx.strokeStyle = `rgba(255,255,255,${g.range(0.12, 0.25)})`
    ctx.lineWidth = g.range(1, wid * 0.05)
    ctx.beginPath()
    ctx.moveTo(x, -wid / 2)
    ctx.lineTo(x + g.range(-wid * 0.4, wid * 0.4), wid / 2)
    ctx.stroke()
  }
  ctx.restore()
}

// ---------- ink, charcoal, scribbles, scratches ----------

export function inkSplat(ctx: Ctx, g: Rng, x: number, y: number, r: number, color = '#0b0b0b'): void {
  ctx.save()
  ctx.fillStyle = color
  // Main blob: lumpy circle.
  const n = 28
  const seed = g.int(0, 1e6)
  ctx.beginPath()
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2
    const rr = r * (0.75 + 0.35 * noise1(seed, k * 0.7) + (g.chance(0.12) ? g.range(0.2, 0.7) : 0))
    const px = x + Math.cos(a) * rr
    const py = y + Math.sin(a) * rr
    if (k) ctx.lineTo(px, py)
    else ctx.moveTo(px, py)
  }
  ctx.closePath()
  ctx.globalAlpha = g.range(0.75, 0.95)
  ctx.fill()
  // Droplets thrown outward.
  for (let k = 0; k < 26; k++) {
    const a = g.range(0, Math.PI * 2)
    const d = r * (1.1 + Math.abs(g.gauss()) * 1.1)
    const dr = Math.max(0.6, r * g.range(0.02, 0.16) * (1.6 - d / (r * 3)))
    ctx.globalAlpha = g.range(0.6, 0.95)
    ctx.beginPath()
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, dr, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Dry-brush / charcoal smudge: a cloud of grainy dark specks, densest along a stroke. */
export function charcoal(ctx: Ctx, g: Rng, x: number, y: number, len: number, wid: number, angle: number, color = '#111'): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = color
  const count = Math.round(len * wid * 0.012) + 60
  for (let k = 0; k < Math.min(count, 2600); k++) {
    const t = g.range(-0.5, 0.5)
    const spread = wid * (0.5 - Math.abs(t) * 0.6)
    const px = t * len
    const py = g.gauss() * spread * 0.45
    ctx.globalAlpha = g.range(0.15, 0.85)
    const s = g.range(0.4, 2.4) * Math.max(0.6, wid / 60)
    ctx.fillRect(px, py, s * g.range(1, 3), s)
  }
  ctx.restore()
}

/** Wiry pencil/pen line that wanders and loops. */
export function scribble(ctx: Ctx, g: Rng, x: number, y: number, size: number, width: number, color = '#111', loops = 0.5): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = width
  ctx.globalAlpha = g.range(0.7, 0.95)
  let px = x
  let py = y
  let heading = g.range(0, Math.PI * 2)
  const steps = g.int(18, 40)
  const stepLen = size / steps * g.range(1.4, 2.4)
  const seed = g.int(0, 1e6)
  ctx.beginPath()
  ctx.moveTo(px, py)
  for (let k = 0; k < steps; k++) {
    heading += noise1(seed, k * 0.25) * 0.9 + (g.chance(loops * 0.15) ? g.sign() * g.range(1.2, 2.6) : 0)
    const nx = px + Math.cos(heading) * stepLen
    const ny = py + Math.sin(heading) * stepLen
    ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2)
    px = nx
    py = ny
  }
  ctx.stroke()
  ctx.restore()
}

/** White scraped marks (paint scratched off), a few parallel hairlines per mark. */
export function scratch(ctx: Ctx, g: Rng, x: number, y: number, len: number, width: number, color = '#fff'): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(g.range(-1.2, 1.2))
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  const lines = g.int(2, 6)
  for (let k = 0; k < lines; k++) {
    ctx.globalAlpha = g.range(0.4, 0.95)
    ctx.lineWidth = width * g.range(0.3, 1.2)
    const oy = g.gauss() * width * 2
    const l = len * g.range(0.4, 1)
    ctx.beginPath()
    ctx.moveTo(-l / 2, oy)
    ctx.quadraticCurveTo(0, oy + g.range(-width * 3, width * 3), l / 2, oy + g.range(-width * 2, width * 2))
    ctx.stroke()
  }
  ctx.restore()
}

/** Five-point star (or burst with more points) ring centered at cx, cy. */
export function starRing(cx: number, cy: number, r: number, points: number, inner: number, rot: number): Ring {
  const out: Ring = []
  for (let k = 0; k < points * 2; k++) {
    const rr = k % 2 ? r * inner : r
    const a = rot - Math.PI / 2 + (k * Math.PI) / points
    out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
  }
  return out
}

export function blobRing(cx: number, cy: number, r: number, g: Rng, lumps = 7): Ring {
  const out: Ring = []
  const seed = g.int(0, 1e6)
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2
    const rr = r * (0.82 + 0.22 * noise1(seed, (k / 48) * lumps))
    out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
  }
  return out
}

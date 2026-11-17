import type { Rng } from './rng'
import { rng } from './rng'
import type { Ring, Shape } from './mask'
import type { MaskData } from '../vision/Vision'
import { fillPaper, grain, canvas } from './paper'

export type Aspect = 'source' | '9:16' | '4:5' | '1:1' | '16:9'

export const ASPECTS: Record<Exclude<Aspect, 'source'>, number> = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 }

/** Output size for an aspect with the long side = `long` (even numbers for the encoder). */
export function outputSize(aspect: Aspect, srcW: number, srcH: number, long: number): { W: number; H: number } {
  const ar = aspect === 'source' ? srcW / srcH : ASPECTS[aspect]
  const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
  return ar >= 1 ? { W: even(long), H: even(long / ar) } : { W: even(long * ar), H: even(long) }
}

/** Source → output transform: X = ox + x * s. */
export interface FitMap {
  s: number
  ox: number
  oy: number
}

export function fitMap(srcW: number, srcH: number, W: number, H: number, fit: 'cover' | 'contain', zoom = 1): FitMap {
  const s = (fit === 'cover' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH)) * zoom
  return { s, ox: (W - srcW * s) / 2, oy: (H - srcH * s) / 2 }
}

export interface OutFace {
  cx: number
  cy: number
  rx: number
  ry: number
  angle: number
}

/** A loaded still used as fill / time-slip material. */
export type Still = ImageBitmap | HTMLCanvasElement

/** A cut-out shape image (FILL): normalized outline rings (0..1 in image space) + the image's aspect. */
export interface ShapeImage {
  name: string
  rings: Ring[]
  aspect: number
}

export interface Assets {
  /** User fill library (images + frames pulled from videos). */
  library: Still[]
  /** Frames from across the source video, for fills and time-slip when there is no library. */
  snapshots: Still[]
  shapeImages: ShapeImage[]
}

export interface Frame {
  ctx: CanvasRenderingContext2D
  W: number
  H: number
  /** 1 unit = 1 px at 1080 on the short side; every size param is in units so preview == export. */
  u: number
  t: number
  duration: number
  /** Boil step index: everything random re-rolls when it changes. */
  step: number
  seed: number
  r: (...key: (string | number)[]) => Rng
  src: CanvasImageSource
  srcW: number
  srcH: number
  map: FitMap
  shapes: Shape[]
  /** The smoothed soft mask (covers the whole source frame), for alpha-matte cut-outs. */
  mask: MaskData | null
  faces: OutFace[]
  transparent: boolean
  assets: Assets
}

export function makeRng(seed: number, step: number): Frame['r'] {
  return (...key) => rng(seed, step, ...key)
}

// ---------- shared drawing ----------

const scratchCanvases = new Map<string, HTMLCanvasElement>()

/** A reusable offscreen canvas of at least w×h. */
export function scratch(name: string, w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  let c = scratchCanvases.get(name)
  if (!c || c.width !== w || c.height !== h) {
    c = canvas(w, h)
    scratchCanvases.set(name, c)
  }
  const ctx = c.getContext('2d', { willReadFrequently: name.startsWith('px') })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  return { c, ctx }
}

/** Draw the source frame through the fit map with an optional CSS filter. */
export function drawSource(f: Frame, filter = 'none', ctx: CanvasRenderingContext2D = f.ctx, img: CanvasImageSource = f.src): void {
  ctx.save()
  ctx.filter = filter
  const { s, ox, oy } = f.map
  // Stills may be at a different resolution than the live source: stretch to the same footprint.
  ctx.drawImage(img, ox, oy, f.srcW * s, f.srcH * s)
  ctx.restore()
}

export type BgMode = 'original' | 'bw' | 'blur' | 'paper' | 'solid' | 'white'

export function drawBackground(f: Frame, mode: BgMode, color: string, paperTone = '#efece4', dim = 0): void {
  if (f.transparent) return
  const { ctx, W, H, u } = f
  if (mode === 'original') drawSource(f)
  else if (mode === 'bw') drawSource(f, 'grayscale(1) contrast(1.15)')
  else if (mode === 'blur') {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    drawSource(f, `blur(${Math.round(16 * u)}px) saturate(1.1)`)
  } else if (mode === 'paper') fillPaper(ctx, paperTone, 0, 0, W, H, u)
  else {
    ctx.fillStyle = mode === 'white' ? '#ffffff' : color
    ctx.fillRect(0, 0, W, H)
  }
  if (dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${dim})`
    ctx.fillRect(0, 0, W, H)
  }
}

export interface Finish {
  paper: number
  grain: number
}

/** Global finish: paper multiply and animated grain (changes with the boil step). */
export function applyFinish(f: Frame, fin: Finish): void {
  const { ctx, W, H, u } = f
  ctx.save()
  if (fin.paper > 0 && !f.transparent) {
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = fin.paper
    fillPaper(ctx, '#f3efe6', 0, 0, W, H, u, 11)
  }
  if (fin.grain > 0) {
    ctx.globalCompositeOperation = f.transparent ? 'source-atop' : 'overlay'
    ctx.globalAlpha = fin.grain * 0.6
    const g = f.r('grain')
    const pat = ctx.createPattern(grain(f.step), 'repeat')!
    pat.setTransform(new DOMMatrix().translate(g.range(0, 256), g.range(0, 256)).scale(Math.max(1, u)))
    ctx.fillStyle = pat
    ctx.fillRect(0, 0, W, H)
  }
  ctx.restore()
}

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

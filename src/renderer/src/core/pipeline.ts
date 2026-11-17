import type { MaskData, PersonModel, Face } from '../vision/Vision'
import type { StyleDef } from '../styles'
import { boxBlur, IdTracker, innerPoint, labelComponents, MaskSmoother, ringBounds, traceBlob, type Shape } from './mask'
import { applyFinish, fitMap, makeRng, type Aspect, type Assets, type Frame } from './frame'

export type MatteEngine = 'saliency' | 'people'

/** Settings shared by every style. */
export interface Global {
  [k: string]: unknown
  aspect: Aspect
  fit: 'cover' | 'contain'
  zoom: number
  boilFps: number
  holdFps: number
  seed: number
  paper: number
  grain: number
  maskSource: 'live' | 'hq'
  liveModel: PersonModel
  hqEngine: MatteEngine
  threshold: number
  smoothing: number
  edgeBlur: number
  minArea: number
  previewScale: number
  transparent: boolean
}

export const GLOBAL_DEFAULTS: Global = {
  aspect: 'source',
  fit: 'cover',
  zoom: 1,
  boilFps: 8,
  holdFps: 0,
  seed: 1,
  paper: 0,
  grain: 0.25,
  maskSource: 'live',
  liveModel: 'multiclass',
  hqEngine: 'saliency',
  threshold: 0.5,
  smoothing: 0.35,
  edgeBlur: 1,
  minArea: 0.4,
  previewScale: 0.5,
  transparent: false
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D
  W: number
  H: number
  t: number
  duration: number
  src: CanvasImageSource
  srcW: number
  srcH: number
  /** Fresh mask for this frame (null = none / not needed). */
  mask: MaskData | null
  /** Faces in source-normalized coords. */
  faces: Face[]
  style: StyleDef
  params: Record<string, unknown>
  global: Global
  assets: Assets
  /** Draw only the source (before/after compare). */
  before?: boolean
}

/** Mask → tracked shapes → style → finish. Holds the temporal state (smoothing, ids, held outlines). */
export class Pipeline {
  private smoother = new MaskSmoother()
  private tracker = new IdTracker()
  private held: { step: number; key: string; shapes: Shape[] } | null = null
  private lastMask: MaskData | null = null
  private lastShapes: Shape[] = []
  private smoothed: MaskData | null = null
  private lastKey = ''
  /** Shapes drawn in the last frame (diagnostics). */
  shapeCount = 0

  reset(): void {
    this.smoother.reset()
    this.tracker.reset()
    this.held = null
    this.lastMask = null
    this.lastShapes = []
    this.smoothed = null
    this.lastKey = ''
  }

  private shapes(mask: MaskData, g: Global, W: number, H: number, srcW: number, srcH: number): Shape[] {
    const map = fitMap(srcW, srcH, W, H, g.fit, g.zoom)
    const key = `${W}x${H}|${g.fit}|${g.zoom}|${g.threshold}|${g.edgeBlur}|${g.minArea}|${g.smoothing}`
    // Same mask object and same layout: reuse (paused preview re-renders on every param tweak).
    if (mask === this.lastMask && key === this.lastKey) return this.lastShapes
    let m = this.smoother.apply(mask, g.smoothing)
    this.smoothed = m
    if (g.edgeBlur > 0) m = boxBlur(m, Math.round(g.edgeBlur))
    const { labels, blobs } = labelComponents(m, g.threshold, (g.minArea / 100) * m.w * m.h)
    // Drop crumbs: anything under 8% of the biggest subject is a fragment, not a person.
    const sorted = blobs.sort((a, b) => b.area - a.area)
    const top = sorted.filter((b) => b.area >= sorted[0].area * 0.08).slice(0, 12)
    const ids = this.tracker.assign(top, m.w, m.h)
    if ((globalThis as { __cutoutDebug?: boolean }).__cutoutDebug)
      console.log(`[cutout] shapes: mask ${m.w}x${m.h} blobs=${blobs.length} top=${top.length} areas=${top.map((b) => b.area).join(',')} minArea=${((g.minArea / 100) * m.w * m.h).toFixed(0)}`)
    const kx = (srcW / m.w) * map.s
    const ky = (srcH / m.h) * map.s
    const out: Shape[] = []
    for (const b of top) {
      const rings = traceBlob(m, labels, b, g.threshold).map((r) => r.map(([x, y]) => [map.ox + x * kx, map.oy + y * ky] as [number, number]))
      if (!rings.length) continue
      const bb = ringBounds(rings)
      const ip = innerPoint(m, labels, b)
      out.push({
        id: ids.get(b.label)!,
        rings,
        cx: map.ox + (ip.x + 0.5) * kx,
        cy: map.oy + (ip.y + 0.5) * ky,
        cover: b.area / (m.w * m.h),
        ...bb
      })
    }
    this.lastMask = mask
    this.lastKey = key
    this.lastShapes = out
    return out
  }

  render(i: RenderInput): void {
    const { ctx, W, H, global: g } = i
    const map = fitMap(i.srcW, i.srcH, W, H, g.fit, g.zoom)
    const step = Math.floor(i.t * g.boilFps + 1e-6)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (i.before) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(i.src as CanvasImageSource, map.ox, map.oy, i.srcW * map.s, i.srcH * map.s)
      ctx.restore()
      return
    }

    let shapes: Shape[] = []
    if (i.mask) {
      const key = `${W}x${H}|${g.fit}|${g.zoom}`
      if (i.style.hold(i.params as never) && this.held && this.held.step === step && this.held.key === key) shapes = this.held.shapes
      else {
        shapes = this.shapes(i.mask, g, W, H, i.srcW, i.srcH)
        this.held = { step, key, shapes }
      }
    }
    this.shapeCount = shapes.length
    const sw = i.srcW * map.s
    const sh = i.srcH * map.s
    const f: Frame = {
      ctx,
      W,
      H,
      u: Math.min(W, H) / 1080,
      t: i.t,
      duration: i.duration,
      step,
      seed: g.seed,
      r: makeRng(g.seed, step),
      src: i.src,
      srcW: i.srcW,
      srcH: i.srcH,
      map,
      shapes,
      mask: i.mask ? this.smoothed : null,
      faces: i.faces.map((fc) => ({ cx: map.ox + fc.cx * sw, cy: map.oy + fc.cy * sh, rx: fc.rx * sw, ry: fc.ry * sh, angle: fc.angle })),
      // Any look that leaves alpha counts: the finish then grains only the subject, never the empty area.
      transparent: g.transparent || !!i.style.alpha?.(i.params as never),
      assets: i.assets
    }
    i.style.render(f, i.params as never)
    applyFinish(f, { paper: g.paper, grain: g.grain })
    ctx.restore()
  }
}

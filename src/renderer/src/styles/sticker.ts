import type { StyleDef } from './types'
import { BG_OPTIONS, SWATCH } from './types'
import { drawBackground, drawSource, scratch, type BgMode, type Frame } from '../core/frame'
import { chaikin, offsetRing, resample, ringArea, ringBounds, roughen, simplifyRing, traceSmooth, type Ring } from '../core/mask'
import { blobRing, ringPath, starRing, tear } from '../core/paper'
import { noise1 } from '../core/rng'
import { drawCaptions, parseCaptions, type CaptionFont } from './captions'

/** STICKER: B&W cut-out subject with a white sticker border, marker scribbles, a shape behind, kinetic type. */

export interface StickerParams {
  [k: string]: unknown
  subject: 'bw' | 'color' | 'selective'
  keepHue: number
  hueTol: number
  contrast: number
  background: BgMode
  bgColor: string
  bgDim: number
  border: number
  borderColor: string
  rough: number
  fillHoles: boolean
  shadow: number
  accent: string
  scribble: boolean
  loops: number
  scribbleWidth: number
  scribbleOffset: number
  wobble: number
  cover: number
  shape: 'star' | 'burst' | 'circle' | 'blob' | 'none'
  shapeSize: number
  shapeX: number
  shapeY: number
  shapeBorder: number
  captions: string
  capX: number
  capY: number
  capSize: number
  capColor: string
  capFont: CaptionFont
  capBehind: boolean
}

/** Outer rings (same winding as the biggest ring); the rest are holes. */
function outers(rings: Ring[]): Ring[] {
  if (rings.length < 2) return rings
  let big = rings[0]
  let bigA = 0
  for (const r of rings) {
    const a = Math.abs(ringArea(r))
    if (a > bigA) {
      bigA = a
      big = r
    }
  }
  const s = Math.sign(ringArea(big))
  return rings.filter((r) => Math.sign(ringArea(r)) === s)
}

/** Keep one hue range in color, everything else gray (in place on an ImageData). */
function selective(img: ImageData, hue: number, tol: number): void {
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const gray = 0.299 * r + 0.587 * g + 0.114 * b
    const c = max - min
    let keep = 0
    // Only clearly saturated pixels qualify, so skin (low chroma, orange-red) stays gray.
    if (c > 60 && max > 50 && c / max > 0.45) {
      let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4
      h *= 60
      if (h < 0) h += 360
      let dh = Math.abs(h - hue)
      if (dh > 180) dh = 360 - dh
      keep = Math.max(0, Math.min(1, (tol - dh) / (tol * 0.35))) * Math.min(1, (c - 60) / 50)
    }
    d[i] = gray + (r - gray) * keep * 1.15
    d[i + 1] = gray + (g - gray) * keep * 1.15
    d[i + 2] = gray + (b - gray) * keep * 1.15
  }
}

function subjectImage(f: Frame, p: StickerParams, bx: { x0: number; y0: number; x1: number; y1: number }): HTMLCanvasElement {
  const { c, ctx } = scratch('pxSticker', f.W, f.H)
  ctx.clearRect(0, 0, f.W, f.H)
  const con = `contrast(${p.contrast})`
  drawSource(f, p.subject === 'bw' ? `grayscale(1) ${con}` : con, ctx)
  if (p.subject === 'selective') {
    const x0 = Math.max(0, Math.floor(bx.x0))
    const y0 = Math.max(0, Math.floor(bx.y0))
    const w = Math.min(f.W, Math.ceil(bx.x1)) - x0
    const h = Math.min(f.H, Math.ceil(bx.y1)) - y0
    if (w > 0 && h > 0) {
      const img = ctx.getImageData(x0, y0, w, h)
      selective(img, p.keepHue, p.hueTol)
      ctx.putImageData(img, x0, y0)
    }
  }
  return c
}

let captionCache: { text: string; duration: number; lines: ReturnType<typeof parseCaptions> } | null = null

function captions(f: Frame, p: StickerParams): void {
  if (!p.captions.trim()) return
  if (!captionCache || captionCache.text !== p.captions || captionCache.duration !== f.duration)
    captionCache = { text: p.captions, duration: f.duration, lines: parseCaptions(p.captions, f.duration) }
  drawCaptions(f, captionCache.lines, { x: p.capX, y: p.capY, size: p.capSize, color: p.capColor, accent: p.accent, font: p.capFont })
}

export const sticker: StyleDef<StickerParams> = {
  id: 'sticker',
  name: 'STICKER',
  blurb: 'B&W cut-out, white border, marker scribble, kinetic type',
  chip: '#e8202a',
  defaults: {
    subject: 'selective',
    keepHue: 354,
    hueTol: 20,
    contrast: 1.15,
    background: 'original',
    bgColor: '#e9e4d8',
    bgDim: 0,
    border: 13,
    borderColor: '#ffffff',
    rough: 2.5,
    fillHoles: true,
    shadow: 0.45,
    accent: '#e8202a',
    scribble: true,
    loops: 2,
    scribbleWidth: 4,
    scribbleOffset: 4,
    wobble: 16,
    cover: 0.8,
    shape: 'none',
    shapeSize: 0.62,
    shapeX: 0,
    shapeY: -0.12,
    shapeBorder: 0,
    captions: 'Cut *yourself* out\nstick it on *anything*\nmake it *yours*',
    capX: 0.5,
    capY: 0.3,
    capSize: 1,
    capColor: '#ffffff',
    capFont: 'mix',
    capBehind: false
  },
  presets: [
    { name: 'Red market', values: { subject: 'selective', keepHue: 354, background: 'original', shape: 'none', scribble: true, accent: '#e8202a' } },
    { name: 'Red star', values: { subject: 'bw', background: 'bw', shape: 'star', shapeSize: 0.7, scribble: true, loops: 1, accent: '#e8202a' } },
    { name: 'Text behind', values: { subject: 'color', background: 'original', shape: 'none', scribble: false, capBehind: true, capY: 0.36, capSize: 1.5, capFont: 'serif' } },
    { name: 'Zine', values: { subject: 'bw', background: 'paper', shape: 'blob', shapeSize: 0.75, accent: '#1f49ff', scribble: true, loops: 3, contrast: 1.4 } },
    { name: 'Clean sticker', values: { subject: 'color', background: 'blur', bgDim: 0.25, shape: 'none', scribble: false, border: 18, rough: 0.5, captions: '' } }
  ],
  random: {
    subject: { pick: ['bw', 'selective', 'selective', 'color'] },
    keepHue: { pick: [354, 354, 215, 48, 135, 290] },
    contrast: { min: 1, max: 1.6 },
    background: { pick: ['original', 'original', 'bw', 'blur', 'paper', 'solid'] },
    bgColor: { pick: SWATCH.ground },
    bgDim: { pick: [0, 0, 0.15, 0.3] },
    border: { min: 6, max: 26 },
    rough: { min: 0, max: 6 },
    shadow: { min: 0.15, max: 0.8 },
    accent: { pick: SWATCH.accent },
    scribble: { pick: [true, true, true, false] },
    loops: { min: 1, max: 3, int: true },
    scribbleWidth: { min: 2, max: 8 },
    scribbleOffset: { min: -10, max: 40, int: true },
    wobble: { min: 6, max: 30 },
    cover: { min: 0.5, max: 1.4 },
    shape: { pick: ['none', 'none', 'star', 'burst', 'circle', 'blob'] },
    shapeSize: { min: 0.45, max: 1 },
    shapeX: { min: -0.4, max: 0.4 },
    shapeY: { min: -0.4, max: 0.2 },
    shapeBorder: { pick: [0, 0, 8, 14] },
    capFont: { pick: ['mix', 'mix', 'serif', 'black', 'sans'] },
    capSize: { min: 0.7, max: 1.4 },
    capX: { min: 0.35, max: 0.65 },
    capY: { min: 0.15, max: 0.4 },
    capBehind: { pick: [false, false, true] }
  },
  fix(p) {
    // Kept hue and marker color should rhyme.
    const hueAccent: Record<number, string> = { 354: '#e8202a', 215: '#1f49ff', 48: '#ffc400', 135: '#00a95c', 290: '#9b3bff' }
    if (p.subject === 'selective') p.accent = hueAccent[p.keepHue] ?? p.accent
    if (p.background === 'solid' && p.bgColor === p.accent) p.bgColor = '#e9e4d8'
  },
  needs: () => ({ person: true, face: false, snapshots: false }),
  hold: () => false,
  controls(folder, p) {
    const s = folder.addFolder({ title: 'Subject' })
    s.addBinding(p, 'subject', { label: 'color', options: { 'black & white': 'bw', 'keep one hue': 'selective', 'full color': 'color' } })
    s.addBinding(p, 'keepHue', { label: 'kept hue', min: 0, max: 360, step: 1 })
    s.addBinding(p, 'hueTol', { label: 'hue range', min: 5, max: 90, step: 1 })
    s.addBinding(p, 'contrast', { min: 0.6, max: 2 })
    const b = folder.addFolder({ title: 'Sticker border' })
    b.addBinding(p, 'border', { label: 'width', min: 0, max: 50, step: 0.5 })
    b.addBinding(p, 'borderColor', { label: 'color' })
    b.addBinding(p, 'rough', { label: 'torn edge', min: 0, max: 12, step: 0.1 })
    b.addBinding(p, 'fillHoles', { label: 'fill gaps' })
    b.addBinding(p, 'shadow', { min: 0, max: 1 })
    const sc = folder.addFolder({ title: 'Marker & shape' })
    sc.addBinding(p, 'accent', { label: 'accent' })
    sc.addBinding(p, 'scribble', { label: 'scribble' })
    sc.addBinding(p, 'loops', { min: 1, max: 4, step: 1 })
    sc.addBinding(p, 'scribbleWidth', { label: 'marker width', min: 1, max: 16, step: 0.5 })
    sc.addBinding(p, 'scribbleOffset', { label: 'offset', min: -30, max: 80, step: 1 })
    sc.addBinding(p, 'wobble', { min: 0, max: 40, step: 0.5 })
    sc.addBinding(p, 'cover', { label: 'coverage', min: 0.2, max: 1.8 })
    sc.addBinding(p, 'shape', { label: 'shape behind', options: { none: 'none', star: 'star', burst: 'burst', circle: 'circle', blob: 'blob' } })
    sc.addBinding(p, 'shapeSize', { label: 'shape size', min: 0.2, max: 1.6 })
    sc.addBinding(p, 'shapeX', { label: 'shape x', min: -1, max: 1 })
    sc.addBinding(p, 'shapeY', { label: 'shape y', min: -1, max: 1 })
    sc.addBinding(p, 'shapeBorder', { label: 'shape border', min: 0, max: 30, step: 0.5 })
    const bg = folder.addFolder({ title: 'Background' })
    bg.addBinding(p, 'background', { label: 'mode', options: BG_OPTIONS })
    bg.addBinding(p, 'bgColor', { label: 'solid color' })
    bg.addBinding(p, 'bgDim', { label: 'dim', min: 0, max: 0.85 })
    const c = folder.addFolder({ title: 'Captions' })
    c.addBinding(p, 'capFont', { label: 'type', options: { mixed: 'mix', 'serif italic': 'serif', 'heavy caps': 'black', 'clean sans': 'sans' } })
    c.addBinding(p, 'capSize', { label: 'size', min: 0.3, max: 2.5 })
    c.addBinding(p, 'capX', { label: 'x', min: 0, max: 1 })
    c.addBinding(p, 'capY', { label: 'y', min: 0, max: 1 })
    c.addBinding(p, 'capColor', { label: 'color' })
    c.addBinding(p, 'capBehind', { label: 'behind subject' })
  },
  render(f, p) {
    const { ctx, u } = f
    drawBackground(f, p.background, p.bgColor, '#efece4', p.bgDim)
    if (p.capBehind) captions(f, p)
    const shapes = f.shapes
    if (shapes.length) {
      const g = f.r('sticker')
      const clean = shapes.map((s) => s.rings.map((r) => chaikin(simplifyRing(r, 0.8 * u), 1)))
      const all = clean.flat()
      const outs = clean.flatMap((rs) => (p.fillHoles ? outers(rs) : rs))
      const box = ringBounds(all)
      const main = [...shapes].sort((a, b) => b.cover - a.cover)[0]

      // Shape behind the main subject.
      if (p.shape !== 'none') {
        const cx = (main.x0 + main.x1) / 2 + (p.shapeX * (main.x1 - main.x0)) / 2
        const cy = (main.y0 + main.y1) / 2 + (p.shapeY * (main.y1 - main.y0)) / 2
        const r = p.shapeSize * 0.5 * Math.max(main.y1 - main.y0, (main.x1 - main.x0) * 1.2)
        const rot = g.range(-0.05, 0.05)
        let ring =
          p.shape === 'star'
            ? starRing(cx, cy, r, 5, 0.45, rot)
            : p.shape === 'burst'
              ? starRing(cx, cy, r, 14, 0.78, rot)
              : p.shape === 'circle'
                ? blobRing(cx, cy, r, g, 0.1)
                : blobRing(cx, cy, r, g, 5)
        ring = tear(ring, g, 2.2 * u, 9 * u)
        const path = ringPath(ring)
        ctx.save()
        if (p.shapeBorder > 0) {
          ctx.lineJoin = 'round'
          ctx.lineWidth = p.shapeBorder * 2 * u
          ctx.strokeStyle = p.borderColor
          ctx.stroke(path)
        }
        ctx.fillStyle = p.accent
        ctx.fill(path)
        ctx.restore()
      }

      // White sticker paper under the subject, torn-rough, with a soft drop shadow.
      if (p.border > 0) {
        const paper = new Path2D()
        // Rough edge re-rolls per boil step but stays fixed on screen within a step.
        traceSmooth(
          paper,
          outs.map((r) => roughen(resample(r, 6 * u), p.rough * u, f.step * 31 + f.seed, 11 * u))
        )
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.lineWidth = p.border * 2 * u
        ctx.strokeStyle = p.borderColor
        ctx.fillStyle = p.borderColor
        if (p.shadow > 0) {
          ctx.shadowColor = `rgba(0,0,0,${0.55 * p.shadow})`
          ctx.shadowBlur = 22 * u
          ctx.shadowOffsetY = 8 * u
        }
        ctx.stroke(paper)
        ctx.fill(paper)
        ctx.shadowColor = 'transparent'
        ctx.stroke(paper)
        ctx.fill(paper)
        ctx.restore()
      }

      // The subject itself, clipped to its outline.
      const pad = (p.border + 4) * u
      const img = subjectImage(f, p, { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad })
      const clip = new Path2D()
      traceSmooth(clip, all)
      ctx.save()
      ctx.clip(clip, 'evenodd')
      ctx.drawImage(img, 0, 0)
      ctx.restore()

      // Hand-drawn marker loops around (and over) the main subject.
      if (p.scribble) {
        const mainRings = clean[shapes.indexOf(main)]
        const ring = outers(mainRings).sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0]
        if (ring) {
          const base = resample(offsetRing(resample(ring, 6 * u), (p.border + p.scribbleOffset) * u), 12 * u)
          const n = base.length
          ctx.save()
          ctx.strokeStyle = p.accent
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          for (let L = 0; L < p.loops; L++) {
            const lg = f.r('scribble', L)
            const seed = lg.int(0, 1e6)
            const start = lg.int(0, n - 1)
            const count = Math.max(4, Math.round(n * p.cover * lg.range(0.75, 1.1)))
            const k = 0.06 + lg.range(0, 0.04)
            const pts = Array.from({ length: count }, (_, i) => {
              const q = base[(start + i) % n]
              const w = p.wobble * u
              return [q[0] + noise1(seed, i * k) * w + lg.range(-1, 1) * u, q[1] + noise1(seed + 9, i * k) * w + lg.range(-1, 1) * u] as const
            })
            ctx.lineWidth = p.scribbleWidth * u * lg.range(0.8, 1.15)
            ctx.globalAlpha = lg.range(0.85, 1)
            ctx.beginPath()
            ctx.moveTo(pts[0][0], pts[0][1])
            for (let i = 1; i < pts.length - 1; i++) {
              const mx = (pts[i][0] + pts[i + 1][0]) / 2
              const my = (pts[i][1] + pts[i + 1][1]) / 2
              ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
            }
            ctx.stroke()
          }
          ctx.restore()
        }
      }
    }
    if (!p.capBehind) captions(f, p)
  }
}

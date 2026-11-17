import { SWATCH, type StyleDef } from './types'
import { drawBackground, drawSource, scratch, type Frame } from '../core/frame'
import { chaikin, ringArea, simplifyRing, traceSmooth, type Ring } from '../core/mask'
import { canvas } from '../core/paper'
import type { MaskData } from '../vision/Vision'

/** CUT: plain background removal. Soft alpha matte (hair-friendly) or crisp vector edge; keep it transparent or swap the background. */

export interface CutParams {
  [k: string]: unknown
  background: 'transparent' | 'solid' | 'blur' | 'bw' | 'paper' | 'dim'
  bgColor: string
  edge: 'soft' | 'hard'
  softness: number
  choke: number
  feather: number
  mainOnly: boolean
  subject: 'color' | 'bw'
  contrast: number
  outline: number
  outlineColor: string
  shadow: number
}

let alphaCache: { mask: MaskData; key: string; c: HTMLCanvasElement } | null = null

/** The mask as an alpha channel, with a levels ramp: threshold (0.5 + choke) ± softness / 2. */
function alphaCanvas(m: MaskData, thr: number, soft: number): HTMLCanvasElement {
  const key = `${thr}|${soft}`
  if (alphaCache && alphaCache.mask === m && alphaCache.key === key) return alphaCache.c
  const c = alphaCache?.c.width === m.w && alphaCache.c.height === m.h ? alphaCache.c : canvas(m.w, m.h)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(m.w, m.h)
  const lut = new Uint8ClampedArray(256)
  const lo = thr - soft / 2
  for (let v = 0; v < 256; v++) {
    const x = soft > 0.001 ? Math.min(1, Math.max(0, (v / 255 - lo) / soft)) : v / 255 >= thr ? 1 : 0
    lut[v] = x * x * (3 - 2 * x) * 255
  }
  for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = lut[m.data[i]]
  ctx.putImageData(img, 0, 0)
  alphaCache = { mask: m, key, c }
  return c
}

function outers(rings: Ring[]): Ring[] {
  if (rings.length < 2) return rings
  const big = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a))
  const s = Math.sign(ringArea(big))
  return rings.filter((r) => Math.sign(ringArea(r)) === s)
}

function subjectRings(f: Frame, mainOnly: boolean): Ring[][] {
  const shapes = mainOnly ? [...f.shapes].sort((a, b) => b.cover - a.cover).slice(0, 1) : f.shapes
  return shapes.map((s) => s.rings.map((r) => chaikin(simplifyRing(r, 0.8 * f.u), 1)))
}

export const cut: StyleDef<CutParams> = {
  id: 'cut',
  name: 'CUT',
  blurb: 'Remove background: transparent or swapped',
  chip: '#7ee0ff',
  defaults: {
    background: 'transparent',
    bgColor: '#00b140',
    edge: 'soft',
    softness: 0.25,
    choke: 0.05,
    feather: 0.6,
    mainOnly: false,
    subject: 'color',
    contrast: 1,
    outline: 0,
    outlineColor: '#ffffff',
    shadow: 0
  },
  presets: [
    { name: 'Transparent', values: {} },
    { name: 'Sticker (white edge)', values: { outline: 14, outlineColor: '#ffffff', shadow: 0.45, edge: 'hard' } },
    { name: 'Green screen', values: { background: 'solid', bgColor: '#00b140' } },
    { name: 'Studio blur', values: { background: 'blur', shadow: 0.3 } },
    { name: 'Paper cut', values: { background: 'paper', edge: 'hard', outline: 10, outlineColor: '#ffffff', shadow: 0.5 } },
    { name: 'Spotlight', values: { background: 'dim', shadow: 0.2 } },
    { name: 'Mono on black', values: { background: 'solid', bgColor: '#0b0b0b', subject: 'bw', contrast: 1.25 } }
  ],
  random: {
    background: { pick: ['transparent', 'solid', 'solid', 'blur', 'bw', 'paper', 'dim'] },
    bgColor: { pick: [...SWATCH.ground, '#00b140', '#ff4fd8', '#ffc400'] },
    edge: { pick: ['soft', 'soft', 'hard'] },
    softness: { min: 0.1, max: 0.35 },
    feather: { pick: [0, 0.6, 1.5] },
    subject: { pick: ['color', 'color', 'bw'] },
    contrast: { min: 1, max: 1.3 },
    outline: { pick: [0, 0, 0, 6, 12, 20] },
    outlineColor: { pick: ['#ffffff', '#ffffff', '#111111', '#e8202a', '#d4f23a'] },
    shadow: { pick: [0, 0, 0.3, 0.55] }
  },
  fix(p) {
    if (p.outline > 0 && p.background === 'solid' && p.bgColor === p.outlineColor) p.outlineColor = p.bgColor === '#ffffff' ? '#111111' : '#ffffff'
  },
  needs: () => ({ person: true, face: false, snapshots: false }),
  hold: () => false,
  alpha: (p) => p.background === 'transparent',
  controls(folder, p, hooks) {
    folder.addBinding(hooks.global, 'hqEngine', { label: 'GPU cut-out of', options: { 'main subject': 'saliency', 'people only': 'people' } })
    folder.addButton({ title: '✨ Best-quality cut-out (GPU)' }).on('click', () => hooks.makeHq())
    const m = folder.addFolder({ title: 'Matte' })
    m.addBinding(p, 'edge', { options: { 'soft (hair, motion)': 'soft', 'hard (clean cut)': 'hard' } })
    m.addBinding(p, 'softness', { label: 'edge softness', min: 0, max: 0.6 })
    m.addBinding(p, 'choke', { label: 'shrink / grow', min: -0.35, max: 0.35 })
    m.addBinding(p, 'feather', { min: 0, max: 12, step: 0.1 })
    m.addBinding(p, 'mainOnly', { label: 'main subject only' })
    const l = folder.addFolder({ title: 'Subject' })
    l.addBinding(p, 'subject', { label: 'color', options: { 'full color': 'color', 'black & white': 'bw' } })
    l.addBinding(p, 'contrast', { min: 0.6, max: 2 })
    l.addBinding(p, 'outline', { label: 'outline', min: 0, max: 40, step: 0.5 })
    l.addBinding(p, 'outlineColor', { label: 'outline color' })
    l.addBinding(p, 'shadow', { label: 'drop shadow', min: 0, max: 1 })
    const b = folder.addFolder({ title: 'Background' })
    b.addBinding(p, 'background', {
      label: 'replace with',
      options: { 'nothing (transparent)': 'transparent', 'solid color': 'solid', 'blurred original': 'blur', 'b&w original': 'bw', 'dimmed original': 'dim', paper: 'paper' }
    })
    b.addBinding(p, 'bgColor', { label: 'color' })
  },
  render(f, p) {
    const { ctx, W, H, u } = f
    if (p.background === 'solid') {
      if (!f.transparent) {
        ctx.fillStyle = p.bgColor
        ctx.fillRect(0, 0, W, H)
      }
    } else if (p.background === 'dim') drawBackground(f, 'original', '', '', 0.62)
    else if (p.background !== 'transparent') drawBackground(f, p.background, p.bgColor)
    if (!f.mask && !f.shapes.length) return

    const ringsBy = subjectRings(f, p.mainOnly)
    const outline = new Path2D()
    traceSmooth(outline, ringsBy.flatMap(outers))

    // Subject layer: source, then masked by the matte.
    const { c: layer, ctx: lc } = scratch('cutLayer', W, H)
    lc.clearRect(0, 0, W, H)
    drawSource(f, p.subject === 'bw' ? `grayscale(1) contrast(${p.contrast})` : `contrast(${p.contrast})`, lc)
    // The matte is built on its own canvas, then applied in one destination-in pass.
    const { c: mc, ctx: mx } = scratch('cutMask', W, H)
    mx.clearRect(0, 0, W, H)
    mx.fillStyle = '#000'
    mx.strokeStyle = '#000'
    mx.lineJoin = 'round'
    if (p.edge === 'soft' && f.mask) {
      mx.drawImage(alphaCanvas(f.mask, 0.5 + p.choke, p.softness), f.map.ox, f.map.oy, f.srcW * f.map.s, f.srcH * f.map.s)
      if (p.mainOnly && f.shapes.length > 1) {
        // Keep only what lies inside (a slightly grown) main outline.
        const { c: kc, ctx: kx } = scratch('cutKeep', W, H)
        kx.clearRect(0, 0, W, H)
        kx.fillStyle = '#000'
        kx.strokeStyle = '#000'
        kx.lineJoin = 'round'
        kx.lineWidth = 24 * u
        kx.fill(outline)
        kx.stroke(outline)
        mx.globalCompositeOperation = 'destination-in'
        mx.drawImage(kc, 0, 0)
        mx.globalCompositeOperation = 'source-over'
      }
    } else {
      const all = new Path2D()
      traceSmooth(all, ringsBy.flat())
      mx.fill(all, 'evenodd')
      if (p.choke !== 0) {
        // Hard edge: grow with a stroke, shrink by erasing one.
        mx.lineWidth = Math.abs(p.choke) * 60 * u
        if (p.choke > 0) mx.globalCompositeOperation = 'destination-out'
        mx.stroke(all)
        mx.globalCompositeOperation = 'source-over'
      }
    }
    lc.globalCompositeOperation = 'destination-in'
    lc.filter = p.feather > 0 ? `blur(${(p.feather * u).toFixed(2)}px)` : 'none'
    lc.drawImage(mc, 0, 0)
    lc.filter = 'none'
    lc.globalCompositeOperation = 'source-over'

    ctx.save()
    if (p.outline > 0 && ringsBy.length) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = p.outline * 2 * u
      ctx.strokeStyle = p.outlineColor
      ctx.fillStyle = p.outlineColor
      if (p.shadow > 0) {
        ctx.shadowColor = `rgba(0,0,0,${0.55 * p.shadow})`
        ctx.shadowBlur = 24 * u
        ctx.shadowOffsetY = 10 * u
      }
      ctx.stroke(outline)
      ctx.fill(outline)
      ctx.shadowColor = 'transparent'
    } else if (p.shadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${0.6 * p.shadow})`
      ctx.shadowBlur = 30 * u
      ctx.shadowOffsetY = 12 * u
    }
    ctx.drawImage(layer, 0, 0)
    ctx.restore()
  }
}

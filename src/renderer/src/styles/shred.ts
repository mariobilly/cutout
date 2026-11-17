import type { StyleDef } from './types'
import { drawSource, type Frame } from '../core/frame'
import { chaikin, simplifyRing, traceSmooth, ringArea } from '../core/mask'
import { charcoal, fillPaper, inkSplat, rectRing, ringPath, scratch, scribble, tape, tear } from '../core/paper'

/** SHRED: a B&W portrait re-assembled from offset strips, black bars, tape, ink and charcoal (Yossip). */

export interface ShredParams {
  [k: string]: unknown
  focus: 'face' | 'subject' | 'center'
  strips: number
  vertical: number
  stripWidth: number
  offset: number
  slip: number
  scaleVar: number
  torn: number
  blank: number
  bars: number
  tape: number
  ink: number
  charcoal: number
  scribbles: number
  scratches: number
  contrast: number
  brightness: number
  fade: number
  cutBase: boolean
  sheet: boolean
  shake: number
  backdrop: string
  paper: string
  inkColor: string
  tapeColor: string
}

interface Region {
  x0: number
  y0: number
  w: number
  h: number
}

function region(f: Frame, p: ShredParams): Region {
  const face = [...f.faces].sort((a, b) => b.rx * b.ry - a.rx * a.ry)[0]
  if (p.focus === 'face' && face) {
    const w = face.rx * 4.2
    const h = face.ry * 4.4
    return { x0: face.cx - w / 2, y0: face.cy - h * 0.42, w, h }
  }
  const main = [...f.shapes].sort((a, b) => b.cover - a.cover)[0]
  if (p.focus !== 'center' && main) {
    const w = main.x1 - main.x0
    const h = Math.min(main.y1 - main.y0, w * 1.6)
    return { x0: main.x0, y0: main.y0, w, h }
  }
  return { x0: f.W * 0.2, y0: f.H * 0.15, w: f.W * 0.6, h: f.H * 0.6 }
}

export const shred: StyleDef<ShredParams> = {
  id: 'shred',
  name: 'SHRED',
  blurb: 'Portrait torn into offset strips, tape, ink, charcoal',
  chip: '#d9d4c7',
  defaults: {
    focus: 'face',
    strips: 10,
    vertical: 0.62,
    stripWidth: 0.2,
    offset: 26,
    slip: 0.15,
    scaleVar: 0.08,
    torn: 0.5,
    blank: 0.14,
    bars: 2,
    tape: 2,
    ink: 3,
    charcoal: 5,
    scribbles: 3,
    scratches: 4,
    contrast: 1.5,
    brightness: 1.12,
    fade: 0.06,
    cutBase: true,
    sheet: true,
    shake: 1,
    backdrop: '#9a9a98',
    paper: '#ecebe6',
    inkColor: '#0c0c0c',
    tapeColor: '#b49b78'
  },
  presets: [
    { name: 'Charcoal', values: { strips: 9, bars: 3, tape: 2, ink: 3, charcoal: 5, scribbles: 3, scratches: 4, contrast: 1.7 } },
    { name: 'Tape heavy', values: { strips: 6, bars: 1, tape: 5, ink: 1, charcoal: 2, scribbles: 1, scratches: 2, torn: 0.8 } },
    { name: 'Glitch strips', values: { strips: 18, vertical: 1, stripWidth: 0.12, offset: 40, slip: 0.6, bars: 2, tape: 0, ink: 0, charcoal: 1, scribbles: 0, scratches: 0, torn: 0.1 } },
    { name: 'Quiet', values: { strips: 4, offset: 12, bars: 1, tape: 1, ink: 0, charcoal: 2, scribbles: 1, scratches: 1, contrast: 1.4 } }
  ],
  random: {
    strips: { min: 4, max: 18, int: true },
    vertical: { min: 0.3, max: 1 },
    stripWidth: { min: 0.1, max: 0.3 },
    offset: { min: 8, max: 60, int: true },
    slip: { pick: [0, 0.1, 0.15, 0.3] },
    scaleVar: { min: 0, max: 0.18 },
    torn: { min: 0.2, max: 0.9 },
    blank: { min: 0, max: 0.3 },
    bars: { min: 0, max: 5, int: true },
    tape: { min: 0, max: 4, int: true },
    ink: { min: 0, max: 6, int: true },
    charcoal: { min: 1, max: 9, int: true },
    scribbles: { min: 0, max: 6, int: true },
    scratches: { min: 0, max: 8, int: true },
    contrast: { min: 1.25, max: 2 },
    brightness: { min: 1, max: 1.25 },
    fade: { min: 0, max: 0.2 },
    cutBase: { pick: [true, true, false] },
    sheet: { pick: [true, true, false] },
    shake: { min: 0, max: 2.5 },
    paper: { pick: ['#ecebe6', '#f1e8d6', '#e4e6e8', '#efe9df'] },
    backdrop: { pick: ['#9a9a98', '#1a1a1a', '#c9b79c', '#5b6b7a', '#7d2a24'] },
    tapeColor: { pick: ['#b49b78', '#d9cfb5', '#c2a6a0', '#b49b78'] }
  },
  needs: (p) => ({ person: p.cutBase || p.focus === 'subject', face: p.focus === 'face', snapshots: p.slip > 0 }),
  hold: () => true,
  controls(folder, p) {
    const s = folder.addFolder({ title: 'Strips' })
    s.addBinding(p, 'focus', { options: { face: 'face', subject: 'subject', center: 'center' } })
    s.addBinding(p, 'strips', { min: 0, max: 30, step: 1 })
    s.addBinding(p, 'vertical', { label: 'vertical share', min: 0, max: 1 })
    s.addBinding(p, 'stripWidth', { label: 'strip width', min: 0.04, max: 0.45 })
    s.addBinding(p, 'offset', { label: 'misalign', min: 0, max: 120, step: 1 })
    s.addBinding(p, 'slip', { label: 'time slip', min: 0, max: 1 })
    s.addBinding(p, 'scaleVar', { label: 'scale var', min: 0, max: 0.35 })
    s.addBinding(p, 'torn', { label: 'torn ends', min: 0, max: 1 })
    s.addBinding(p, 'blank', { label: 'blank paper', min: 0, max: 0.6 })
    const m = folder.addFolder({ title: 'Marks' })
    m.addBinding(p, 'bars', { label: 'black bars', min: 0, max: 10, step: 1 })
    m.addBinding(p, 'tape', { min: 0, max: 8, step: 1 })
    m.addBinding(p, 'ink', { label: 'ink splats', min: 0, max: 12, step: 1 })
    m.addBinding(p, 'charcoal', { min: 0, max: 14, step: 1 })
    m.addBinding(p, 'scribbles', { min: 0, max: 12, step: 1 })
    m.addBinding(p, 'scratches', { label: 'white scratches', min: 0, max: 16, step: 1 })
    m.addBinding(p, 'inkColor', { label: 'ink color' })
    m.addBinding(p, 'tapeColor', { label: 'tape color' })
    const pr = folder.addFolder({ title: 'Print & paper' })
    pr.addBinding(p, 'contrast', { min: 0.8, max: 3 })
    pr.addBinding(p, 'brightness', { min: 0.6, max: 1.5 })
    pr.addBinding(p, 'fade', { min: 0, max: 0.6 })
    pr.addBinding(p, 'cutBase', { label: 'cut out subject' })
    pr.addBinding(p, 'sheet', { label: 'paper sheet' })
    pr.addBinding(p, 'shake', { label: 'sheet shake', min: 0, max: 4, step: 0.1 })
    pr.addBinding(p, 'paper', { label: 'paper tone' })
    pr.addBinding(p, 'backdrop', { label: 'backdrop' })
  },
  render(f, p) {
    const { ctx, W, H, u } = f
    const g = f.r('shred')
    const R = region(f, p)
    const bw = `grayscale(1) contrast(${p.contrast}) brightness(${p.brightness})`

    // Backdrop + sheet (the sheet shakes a little each beat, like a re-shot stop-motion page).
    ctx.save()
    let sheetPath: Path2D | null = null
    if (p.sheet) {
      if (!f.transparent) {
        ctx.fillStyle = p.backdrop
        ctx.fillRect(0, 0, W, H)
      }
      const m = Math.min(W, H) * 0.035
      const sh = rectRing(W / 2 + g.range(-1, 1) * p.shake * 2 * u, H / 2 + g.range(-1, 1) * p.shake * 2 * u, W - m * 2, H - m * 2, (g.range(-1, 1) * p.shake * 0.25 * Math.PI) / 180)
      sheetPath = ringPath(sh)
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = 18 * u
      ctx.fillStyle = p.paper
      ctx.fill(sheetPath)
      ctx.shadowColor = 'transparent'
      ctx.clip(sheetPath)
      fillPaper(ctx, p.paper, 0, 0, W, H, u, 3)
    } else if (!f.transparent) fillPaper(ctx, p.paper, 0, 0, W, H, u, 3)

    // Base print, multiplied into the paper; optionally cut out along the subject.
    ctx.save()
    const main = [...f.shapes].sort((a, b) => b.cover - a.cover)[0]
    if (p.cutBase && main) {
      const rings = main.rings.map((r) => chaikin(simplifyRing(r, 1.2 * u), 1))
      const big = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a))
      const clip = new Path2D()
      traceSmooth(clip, [tear(big, g, 1.5 * u, 6 * u)])
      ctx.clip(clip)
    }
    ctx.globalCompositeOperation = 'multiply'
    drawSource(f, bw)
    ctx.restore()
    if (p.fade > 0) {
      ctx.save()
      ctx.globalAlpha = p.fade
      ctx.fillStyle = p.paper
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }

    // Strips: pieces of the same (or another) moment, cut, shifted and pasted back over the face.
    const pool = f.assets.snapshots
    for (let k = 0; k < p.strips; k++) {
      const vertical = g.chance(p.vertical)
      let w: number
      let h: number
      let cx: number
      let cy: number
      if (vertical) {
        w = R.w * g.range(p.stripWidth * 0.5, p.stripWidth * 1.4)
        h = R.h * g.range(0.45, 1.15)
        cx = R.x0 + g.range(0.05, 0.95) * R.w
        cy = R.y0 + g.range(0.3, 0.7) * R.h
      } else {
        h = R.h * g.range(p.stripWidth * 0.3, p.stripWidth * 0.9)
        w = R.w * g.range(0.45, 1.25)
        cx = R.x0 + g.range(0.2, 0.8) * R.w
        cy = R.y0 + g.range(0.15, 0.95) * R.h
      }
      let ring = rectRing(cx, cy, w, h, g.gauss() * 0.015)
      if (g.chance(p.torn)) ring = tear(ring, g, 5 * u, 7 * u, vertical ? [true, false, true, false] : [false, true, false, true])
      const path = ringPath(ring)
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.28)'
      ctx.shadowBlur = 7 * u
      ctx.shadowOffsetY = 2 * u
      ctx.fillStyle = g.chance(0.5) ? '#f6f5f0' : p.paper
      ctx.fill(path)
      ctx.shadowColor = 'transparent'
      if (!g.chance(p.blank)) {
        ctx.clip(path)
        const dx = g.gauss() * p.offset * u
        const dy = g.gauss() * p.offset * u * 0.6
        const sc = 1 + g.gauss() * p.scaleVar
        ctx.translate(cx + dx, cy + dy)
        ctx.scale(sc, sc)
        ctx.translate(-cx, -cy)
        ctx.globalCompositeOperation = 'multiply'
        const src = pool.length && g.chance(p.slip) ? g.pick(pool) : f.src
        drawSource(f, `${bw}${g.chance(0.3) ? ' brightness(0.8)' : ''}`, ctx, src)
      } else {
        ctx.clip(path)
        fillPaper(ctx, g.chance(0.5) ? '#d9d6cf' : '#f2f1ec', cx - w, cy - h, w * 2, h * 2, u, 5)
      }
      ctx.restore()
    }

    // Black bars across eyes / mouth.
    for (let k = 0; k < p.bars; k++) {
      const w = R.w * g.range(0.25, 0.8)
      const h = R.h * g.range(0.035, 0.09)
      const cx = R.x0 + R.w * g.range(0.25, 0.75)
      const cy = R.y0 + R.h * g.pick([0.36, 0.5, 0.62, 0.72]) + g.range(-0.03, 0.03) * R.h
      const ring = tear(rectRing(cx, cy, w, h, g.gauss() * 0.01), g, 1.6 * u, 6 * u)
      ctx.save()
      ctx.globalAlpha = g.range(0.85, 0.97)
      ctx.fillStyle = p.inkColor
      ctx.fill(ringPath(ring))
      ctx.restore()
    }

    // Charcoal smudges, ink, scribbles, scratches: gathered around the face, some strays.
    const near = (spread: number): [number, number] => [R.x0 + R.w * (0.5 + g.gauss() * spread), R.y0 + R.h * (0.5 + g.gauss() * spread)]
    for (let k = 0; k < p.charcoal; k++) {
      const [x, y] = near(0.45)
      charcoal(ctx, g, x, y, R.w * g.range(0.12, 0.45), R.h * g.range(0.03, 0.12), g.range(-0.6, 0.6) + (g.chance(0.3) ? Math.PI / 2 : 0), p.inkColor)
    }
    for (let k = 0; k < p.ink; k++) {
      const [x, y] = near(0.5)
      inkSplat(ctx, g, x, y, u * g.range(5, 24), p.inkColor)
    }
    for (let k = 0; k < p.scribbles; k++) {
      const [x, y] = near(0.5)
      scribble(ctx, g, x, y, R.w * g.range(0.3, 0.9), u * g.range(1.2, 2.6), p.inkColor, g.range(0.3, 1))
    }
    for (let k = 0; k < p.scratches; k++) {
      const [x, y] = near(0.35)
      scratch(ctx, g, x, y, R.w * g.range(0.08, 0.3), u * g.range(1, 3))
    }
    ctx.restore() // sheet clip

    // Tape can overhang the sheet edge.
    for (let k = 0; k < p.tape; k++) {
      const edgeX = g.chance(0.5) ? R.x0 + R.w * g.range(-0.1, 0.25) : R.x0 + R.w * g.range(0.75, 1.1)
      const edgeY = g.chance(0.5) ? R.y0 + R.h * g.range(-0.05, 0.25) : R.y0 + R.h * g.range(0.6, 1)
      tape(ctx, g, edgeX, edgeY, R.w * g.range(0.3, 0.6), u * g.range(46, 78), g.sign() * g.range(0.35, 0.9), p.tapeColor)
    }
    if (sheetPath && !f.transparent) {
      ctx.save()
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'
      ctx.lineWidth = 1.2 * u
      ctx.stroke(sheetPath)
      ctx.restore()
    }
  }
}

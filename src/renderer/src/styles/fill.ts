import { SWATCH, type StyleDef } from './types'
import type { Frame, Still } from '../core/frame'
import { drawBackground, drawSource } from '../core/frame'
import { chaikin, ringBounds, simplifyRing, traceSmooth, type Ring } from '../core/mask'

/** FILL: a silhouette (the subject, or a shape image like a chair) filled with a new picture every beat. */

export interface FillParams {
  [k: string]: unknown
  shapeFrom: 'subject' | 'image'
  size: number
  x: number
  y: number
  wobble: number
  shapeEvery: number
  order: 'cycle' | 'random'
  zoom: number
  saturate: number
  contrast: number
  background: 'white' | 'paper' | 'solid' | 'original' | 'bw'
  bgColor: string
  bars: boolean
  barSize: number
  barColor: string
  edge: number
  edgeColor: string
  shadow: number
  smooth: number
}

/** Shape-image rings placed in the frame: fit inside size×frame, centered at (x, y), slight wobble. */
function placeImageShape(f: Frame, p: FillParams): Ring[] {
  const list = f.assets.shapeImages
  if (!list.length) return []
  const si = list[Math.floor(f.step / Math.max(1, p.shapeEvery)) % list.length]
  const g = f.r('fillshape')
  let h = p.size * f.H
  let w = h * si.aspect
  if (w > p.size * f.W) {
    w = p.size * f.W
    h = w / si.aspect
  }
  const cx = f.W / 2 + p.x * f.W + g.range(-1, 1) * p.wobble * f.u * 2
  const cy = f.H / 2 + p.y * f.H + g.range(-1, 1) * p.wobble * f.u * 2
  const a = (g.range(-1, 1) * p.wobble * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return si.rings.map((r) =>
    r.map(([nx, ny]) => {
      const x = (nx - 0.5) * w
      const y = (ny - 0.5) * h
      return [cx + x * c - y * s, cy + x * s + y * c]
    })
  )
}

function drawCover(ctx: CanvasRenderingContext2D, img: Still, x0: number, y0: number, w: number, h: number, zoom: number, ox: number, oy: number): void {
  const iw = img.width
  const ih = img.height
  const s = Math.max(w / iw, h / ih) * zoom
  const dw = iw * s
  const dh = ih * s
  // ox/oy in [-1, 1] slide the picture within its overflow.
  ctx.drawImage(img, x0 + (w - dw) / 2 + ((dw - w) / 2) * ox, y0 + (h - dh) / 2 + ((dh - h) / 2) * oy, dw, dh)
}

export const fill: StyleDef<FillParams> = {
  id: 'fill',
  name: 'FILL',
  blurb: 'Silhouette filled with a new picture every beat',
  chip: '#9b6bff',
  defaults: {
    shapeFrom: 'subject',
    size: 0.62,
    x: 0,
    y: 0,
    wobble: 2,
    shapeEvery: 1,
    order: 'random',
    zoom: 1.5,
    saturate: 1.15,
    contrast: 1.1,
    background: 'white',
    bgColor: '#ffffff',
    bars: false,
    barSize: 0.11,
    barColor: '#000000',
    edge: 0,
    edgeColor: '#111111',
    shadow: 0.25,
    smooth: 1.2
  },
  presets: [
    { name: 'Gallery white', values: { background: 'white', bars: true, barSize: 0.11, edge: 0, shadow: 0.2 } },
    { name: 'Paper print', values: { background: 'paper', bars: false, edge: 0, shadow: 0.45, saturate: 0.9, contrast: 1.2 } },
    { name: 'Window', values: { background: 'bw', bars: false, edge: 3, edgeColor: '#ffffff', shadow: 0.6, saturate: 1.4 } },
    { name: 'Ink outline', values: { background: 'white', bars: false, edge: 5, edgeColor: '#0a0a0a', shadow: 0 } }
  ],
  random: {
    size: { min: 0.45, max: 0.85 },
    wobble: { min: 0, max: 6 },
    order: { pick: ['random', 'random', 'cycle'] },
    zoom: { min: 1, max: 2.5 },
    saturate: { min: 0.6, max: 1.6 },
    contrast: { min: 0.95, max: 1.5 },
    background: { pick: ['white', 'white', 'paper', 'solid', 'bw'] },
    bgColor: { pick: SWATCH.ground },
    bars: { pick: [false, false, true] },
    barSize: { min: 0.06, max: 0.16 },
    edge: { pick: [0, 0, 0, 2, 4, 6] },
    edgeColor: { pick: ['#111111', '#111111', '#ffffff'] },
    shadow: { min: 0, max: 0.7 }
  },
  fix(p) {
    if (p.edge > 0 && p.background === 'solid' && p.bgColor === p.edgeColor) p.edgeColor = p.bgColor === '#111111' ? '#ffffff' : '#111111'
  },
  needs: (p) => ({ person: p.shapeFrom === 'subject', face: false, snapshots: true }),
  hold: () => true,
  controls(folder, p, hooks) {
    const s = folder.addFolder({ title: 'Silhouette' })
    s.addBinding(p, 'shapeFrom', { label: 'shape from', options: { 'video subject': 'subject', 'shape image(s)': 'image' } })
    s.addButton({ title: 'Choose shape image(s)…' }).on('click', () => hooks.chooseShapes())
    s.addButton({ title: 'Clear shapes' }).on('click', () => hooks.clearShapes())
    s.addBinding(p, 'size', { min: 0.15, max: 1.3 })
    s.addBinding(p, 'x', { min: -0.5, max: 0.5 })
    s.addBinding(p, 'y', { min: -0.5, max: 0.5 })
    s.addBinding(p, 'wobble', { label: 'stop-motion wobble', min: 0, max: 12, step: 0.1 })
    s.addBinding(p, 'shapeEvery', { label: 'shape every n beats', min: 1, max: 12, step: 1 })
    s.addBinding(p, 'smooth', { label: 'edge smooth', min: 0, max: 6, step: 0.1 })
    const fl = folder.addFolder({ title: 'Fill pictures' })
    fl.addButton({ title: 'Choose fill folder…' }).on('click', () => hooks.chooseLibrary())
    fl.addButton({ title: 'Clear (use frames of the video)' }).on('click', () => hooks.clearLibrary())
    fl.addBinding(p, 'order', { options: { random: 'random', 'in order': 'cycle' } })
    fl.addBinding(p, 'zoom', { label: 'max zoom', min: 1, max: 4 })
    fl.addBinding(p, 'saturate', { min: 0, max: 2 })
    fl.addBinding(p, 'contrast', { min: 0.6, max: 2 })
    fl.addBinding(p, 'edge', { label: 'edge line', min: 0, max: 14, step: 0.5 })
    fl.addBinding(p, 'edgeColor', { label: 'edge color' })
    fl.addBinding(p, 'shadow', { min: 0, max: 1 })
    const bg = folder.addFolder({ title: 'Background' })
    bg.addBinding(p, 'background', { label: 'mode', options: { white: 'white', paper: 'paper', solid: 'solid', 'original video': 'original', 'b&w video': 'bw' } })
    bg.addBinding(p, 'bgColor', { label: 'solid color' })
    bg.addBinding(p, 'bars', { label: 'letterbox bars' })
    bg.addBinding(p, 'barSize', { label: 'bar size', min: 0, max: 0.3 })
    bg.addBinding(p, 'barColor', { label: 'bar color' })
  },
  render(f, p) {
    const { ctx, W, H, u } = f
    drawBackground(f, p.background, p.bgColor)
    const rings =
      p.shapeFrom === 'image'
        ? placeImageShape(f, p)
        : f.shapes.flatMap((s) => s.rings.map((r) => chaikin(simplifyRing(r, p.smooth * u), 1)))
    if (rings.length) {
      const path = new Path2D()
      traceSmooth(path, rings)
      const box = ringBounds(rings)
      const bw = box.x1 - box.x0
      const bh = box.y1 - box.y0
      const pool: Still[] = f.assets.library.length ? f.assets.library : f.assets.snapshots
      const g = f.r('fill')
      if (p.shadow > 0 && !f.transparent) {
        ctx.save()
        ctx.shadowColor = `rgba(0,0,0,${0.5 * p.shadow})`
        ctx.shadowBlur = 26 * u
        ctx.shadowOffsetY = 10 * u
        ctx.fillStyle = '#ffffff'
        ctx.fill(path, 'evenodd')
        ctx.restore()
      }
      ctx.save()
      ctx.clip(path, 'evenodd')
      ctx.filter = `saturate(${p.saturate}) contrast(${p.contrast})`
      if (pool.length) {
        const idx = p.order === 'cycle' ? f.step % pool.length : g.int(0, pool.length - 1)
        drawCover(ctx, pool[idx], box.x0, box.y0, bw, bh, g.range(1, p.zoom), g.range(-1, 1), g.range(-1, 1))
      } else {
        // No library and no video frames yet: the live frame, re-zoomed each beat.
        ctx.translate(box.x0 + bw / 2, box.y0 + bh / 2)
        const z = g.range(1, p.zoom)
        ctx.scale(z, z)
        ctx.translate(-(box.x0 + bw / 2), -(box.y0 + bh / 2))
        drawSource(f, ctx.filter)
      }
      ctx.restore()
      if (p.edge > 0) {
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.lineWidth = p.edge * u
        ctx.strokeStyle = p.edgeColor
        ctx.stroke(path)
        ctx.restore()
      }
    }
    if (p.bars && !f.transparent) {
      ctx.fillStyle = p.barColor
      if (H >= W) {
        const b = p.barSize * H
        ctx.fillRect(0, 0, W, b)
        ctx.fillRect(0, H - b, W, b)
      } else {
        const b = p.barSize * W
        ctx.fillRect(0, 0, b, H)
        ctx.fillRect(W - b, 0, b, H)
      }
    }
  }
}

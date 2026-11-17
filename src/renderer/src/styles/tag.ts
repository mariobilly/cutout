import type { StyleDef } from './types'
import { BG_OPTIONS, SWATCH } from './types'
import { drawBackground, type BgMode } from '../core/frame'
import { chaikin, jitterRing, resample, simplifyRing, tracePath, traceSmooth } from '../core/mask'

/** TAG: people as flat color cut-outs with a boiling ink outline and A / B / 1 / 2 labels (typowow). */

const PALETTES: Record<string, string[]> = {
  riso: ['#ff48b0', '#0078bf', '#ffe800', '#00a95c', '#ff6c2f'],
  neon: ['#d4f23a', '#4fc3f7', '#ff4fd8', '#ff7a1a', '#9b6bff'],
  pastel: ['#f6c1cf', '#bfe3d0', '#c9d7f8', '#fbe4a6', '#e1c8f2'],
  mono: ['#111111', '#3a3a3a', '#5c5c5c', '#808080', '#a3a3a3']
}

export interface TagParams {
  [k: string]: unknown
  fill: string
  palette: 'single' | 'riso' | 'neon' | 'pastel' | 'mono'
  fillOpacity: number
  simplify: number
  smooth: number
  corners: 'round' | 'sharp'
  jitter: number
  detail: number
  hold: boolean
  stroke: boolean
  strokeWidth: number
  strokeColor: string
  misregister: number
  labels: 'ABC' | '123' | 'abc' | 'off'
  labelSize: number
  labelColor: string
  labelFont: 'Inter' | 'Archivo Black' | 'Instrument Serif'
  background: BgMode
  bgColor: string
  bgDim: number
  maxPeople: number
}

const labelText = (mode: TagParams['labels'], id: number): string =>
  mode === '123' ? String(id + 1) : mode === 'abc' ? String.fromCharCode(97 + (id % 26)) : String.fromCharCode(65 + (id % 26))

export const tag: StyleDef<TagParams> = {
  id: 'tag',
  name: 'TAG',
  blurb: 'Flat-color people, boiling outline, A/B labels',
  chip: '#d4f23a',
  defaults: {
    fill: '#d4f23a',
    palette: 'single',
    fillOpacity: 1,
    simplify: 3,
    smooth: 1,
    corners: 'round',
    jitter: 2.5,
    detail: 14,
    hold: true,
    stroke: true,
    strokeWidth: 4.5,
    strokeColor: '#0a0a0a',
    misregister: 0,
    labels: 'ABC',
    labelSize: 40,
    labelColor: '#0a0a0a',
    labelFont: 'Inter',
    background: 'original',
    bgColor: '#101010',
    bgDim: 0,
    maxPeople: 8
  },
  presets: [
    { name: 'Neon lime', values: { fill: '#d4f23a', palette: 'single', labels: 'ABC', background: 'original', jitter: 2.5, misregister: 0 } },
    { name: 'Sky', values: { fill: '#4fc3f7', palette: 'single', labels: '123', background: 'original' } },
    { name: 'Sage', values: { fill: '#9dae80', palette: 'single', labels: 'abc', background: 'original', jitter: 1.5 } },
    { name: 'Riso crowd', values: { palette: 'riso', misregister: 7, labels: '123', background: 'bw', fillOpacity: 0.92 } },
    { name: 'Blueprint', values: { fill: '#f5f1e6', palette: 'single', strokeColor: '#f5f1e6', background: 'solid', bgColor: '#1d3fbb', labels: 'ABC', labelColor: '#1d3fbb' } },
    { name: 'Poly shards', values: { simplify: 22, smooth: 0, corners: 'sharp', jitter: 6, detail: 40, palette: 'neon', labels: 'off', background: 'bw' } }
  ],
  random: {
    fill: { pick: SWATCH.neon },
    palette: { pick: ['single', 'single', 'single', 'riso', 'neon', 'pastel'] },
    fillOpacity: { min: 0.8, max: 1 },
    simplify: { pick: [0, 2, 3, 5, 8, 14, 24] },
    smooth: { pick: [0, 1, 1, 2] },
    corners: { pick: ['round', 'round', 'sharp'] },
    jitter: { min: 0, max: 7 },
    detail: { min: 8, max: 34, int: true },
    stroke: { pick: [true, true, true, false] },
    strokeWidth: { min: 2, max: 9 },
    strokeColor: { pick: SWATCH.ink },
    misregister: { pick: [0, 0, 0, 4, 7, 10] },
    labels: { pick: ['ABC', '123', 'abc', 'off'] },
    labelSize: { min: 26, max: 76, int: true },
    labelFont: { pick: ['Inter', 'Archivo Black', 'Instrument Serif'] },
    background: { pick: ['original', 'original', 'bw', 'bw', 'blur', 'solid', 'paper'] },
    bgColor: { pick: SWATCH.ground },
    bgDim: { pick: [0, 0, 0.15, 0.35] }
  },
  fix(p) {
    p.labelColor = p.stroke ? p.strokeColor : '#0a0a0a'
    if (p.background === 'solid' && p.bgColor === p.fill) p.bgColor = '#111111'
  },
  needs: () => ({ person: true, face: false, snapshots: false }),
  hold: (p) => p.hold,
  controls(folder, p) {
    const shape = folder.addFolder({ title: 'Shape' })
    shape.addBinding(p, 'simplify', { label: 'geometry simplify', min: 0, max: 40, step: 0.5 })
    shape.addBinding(p, 'smooth', { label: 'smooth', min: 0, max: 3, step: 1 })
    shape.addBinding(p, 'corners', { options: { round: 'round', sharp: 'sharp' } })
    shape.addBinding(p, 'jitter', { label: 'jitter', min: 0, max: 16, step: 0.1 })
    shape.addBinding(p, 'detail', { label: 'jitter spacing', min: 4, max: 60, step: 1 })
    shape.addBinding(p, 'hold', { label: 'step at boil fps' })
    shape.addBinding(p, 'maxPeople', { label: 'max people', min: 1, max: 12, step: 1 })
    const fill = folder.addFolder({ title: 'Fill & stroke' })
    fill.addBinding(p, 'palette', { options: { 'single color': 'single', riso: 'riso', neon: 'neon', pastel: 'pastel', mono: 'mono' } })
    fill.addBinding(p, 'fill', { label: 'fill color' })
    fill.addBinding(p, 'fillOpacity', { label: 'fill opacity', min: 0, max: 1 })
    fill.addBinding(p, 'misregister', { label: 'print offset', min: 0, max: 20, step: 0.5 })
    fill.addBinding(p, 'stroke', { label: 'stroke' })
    fill.addBinding(p, 'strokeWidth', { label: 'stroke width', min: 0.5, max: 20, step: 0.5 })
    fill.addBinding(p, 'strokeColor', { label: 'stroke color' })
    const lab = folder.addFolder({ title: 'Labels' })
    lab.addBinding(p, 'labels', { label: 'labels', options: { 'A B C': 'ABC', '1 2 3': '123', 'a b c': 'abc', off: 'off' } })
    lab.addBinding(p, 'labelSize', { label: 'size', min: 10, max: 160, step: 1 })
    lab.addBinding(p, 'labelColor', { label: 'color' })
    lab.addBinding(p, 'labelFont', { label: 'font', options: { Inter: 'Inter', 'Archivo Black': 'Archivo Black', 'Instrument Serif': 'Instrument Serif' } })
    const bg = folder.addFolder({ title: 'Background' })
    bg.addBinding(p, 'background', { label: 'mode', options: BG_OPTIONS })
    bg.addBinding(p, 'bgColor', { label: 'solid color' })
    bg.addBinding(p, 'bgDim', { label: 'dim', min: 0, max: 0.85 })
  },
  render(f, p) {
    const { ctx, u } = f
    drawBackground(f, p.background, p.bgColor, '#efece4', p.bgDim)
    const shapes = [...f.shapes].sort((a, b) => a.id - b.id).slice(0, p.maxPeople)
    for (const sh of shapes) {
      const g = f.r('tag', sh.id)
      const rings = sh.rings.map((r) => {
        let q = simplifyRing(r, p.simplify * u)
        q = chaikin(q, p.smooth)
        if (p.jitter > 0) q = jitterRing(resample(q, p.detail * u), p.jitter * u, g)
        return q
      })
      const path = new Path2D()
      ;(p.corners === 'round' ? traceSmooth : tracePath)(path, rings)
      const pal = PALETTES[p.palette]
      const color = pal ? pal[sh.id % pal.length] : p.fill

      ctx.save()
      ctx.globalAlpha = p.fillOpacity
      ctx.fillStyle = color
      if (p.misregister > 0) ctx.translate(p.misregister * u, p.misregister * u * 0.6)
      ctx.fill(path, 'evenodd')
      ctx.restore()
      if (p.stroke) {
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.lineWidth = p.strokeWidth * u
        ctx.strokeStyle = p.strokeColor
        ctx.stroke(path)
        ctx.restore()
      }
      if (p.labels !== 'off') {
        ctx.save()
        const size = p.labelSize * u
        ctx.font = p.labelFont === 'Instrument Serif' ? `italic 400 ${size * 1.25}px "Instrument Serif"` : `${p.labelFont === 'Inter' ? 600 : 400} ${size}px "${p.labelFont}"`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = p.labelColor
        ctx.fillText(labelText(p.labels, sh.id), sh.cx, sh.cy)
        ctx.restore()
      }
    }
  }
}

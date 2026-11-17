import type { Frame } from '../core/frame'

/** Kinetic mixed-type captions: one hero word in display type, the rest small, revealed word by word. */

export interface CaptionWord {
  text: string
  hot: boolean
}

export interface CaptionLine {
  start: number
  end: number
  words: CaptionWord[]
}

export type CaptionFont = 'mix' | 'serif' | 'black' | 'sans'

const TIMED = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[:|]\s*(.*)$/

/**
 * One caption per line. "1.5-3: text" sets the timing; untimed lines share the time left over.
 * *word* marks the hero word (accent color + white outline).
 */
export function parseCaptions(text: string, duration: number): CaptionLine[] {
  const raw = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const parsed = raw.map((l) => {
    const m = TIMED.exec(l)
    return m ? { start: Number(m[1]), end: Number(m[2]), body: m[3] } : { start: NaN, end: NaN, body: l }
  })
  const untimed = parsed.filter((p) => isNaN(p.start))
  if (untimed.length) {
    const dur = Math.max(1, duration || untimed.length * 2)
    const slot = dur / untimed.length
    untimed.forEach((p, i) => {
      p.start = i * slot
      p.end = (i + 1) * slot
    })
  }
  return parsed.map((p) => ({
    start: p.start,
    end: p.end,
    words: p.body
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        const hot = /^\*.+\*[.,!?]?$/.test(w)
        return { text: hot ? w.replace(/\*/g, '') : w, hot }
      })
  }))
}

export interface CaptionStyle {
  x: number
  y: number
  size: number
  color: string
  accent: string
  font: CaptionFont
}

const ease = (x: number): number => 1 - Math.pow(1 - x, 3)

export function drawCaptions(f: Frame, lines: CaptionLine[], s: CaptionStyle): void {
  const li = lines.findIndex((l) => f.t >= l.start && f.t < l.end)
  if (li < 0) return
  const line = lines[li]
  const n = line.words.length
  if (!n) return
  const { ctx, W, H, u } = f
  const base = s.size * 0.15 * Math.min(W, H)
  const small = base * 0.3
  let hero = line.words.findIndex((w) => w.hot)
  if (hero < 0) hero = line.words.reduce((best, w, i) => (w.text.length > line.words[best].text.length ? i : best), 0)

  const lr = f.r('capline', li)
  // Font role is per line (stable), not per boil step.
  const role = s.font === 'mix' ? (Math.abs(Math.sin(li * 12.9898 + 4.1)) % 1 > 0.45 ? 'serif' : 'black') : s.font
  const heroFont =
    role === 'serif' ? `italic 400 ${base * 1.25}px "Instrument Serif"` : role === 'black' ? `400 ${base}px "Archivo Black"` : `700 ${base}px "Inter"`
  const heroText = role === 'black' ? line.words[hero].text.toUpperCase() : line.words[hero].text
  const smallFont = `600 ${small}px "Inter"`

  ctx.save()
  ctx.font = heroFont
  const hw = ctx.measureText(heroText).width
  ctx.font = smallFont
  const before = line.words.slice(0, hero)
  const after = line.words.slice(hero + 1)
  const gap = small * 0.45
  type Placed = { i: number; text: string; x: number; y: number; align: CanvasTextAlign; font: string; hero: boolean; hot: boolean }
  const placed: Placed[] = []
  const ax = s.x * W
  const ay = s.y * H
  const midY = ay - base * 0.18
  placed.push({ i: hero, text: heroText, x: ax, y: ay, align: 'center', font: heroFont, hero: true, hot: line.words[hero].hot })
  if (before.length) {
    const left = before[before.length - 1]
    placed.push({ i: hero - 1, text: left.text, x: ax - hw / 2 - gap, y: midY, align: 'right', font: smallFont, hero: false, hot: left.hot })
    if (before.length > 1) {
      const text = before
        .slice(0, -1)
        .map((w) => w.text)
        .join(' ')
      placed.push({ i: 0, text, x: ax + hw * 0.42, y: ay - base * 0.82, align: 'right', font: smallFont, hero: false, hot: false })
    }
  }
  if (after.length) {
    placed.push({ i: hero + 1, text: after[0].text, x: ax + hw / 2 + gap, y: midY, align: 'left', font: smallFont, hero: false, hot: after[0].hot })
    if (after.length > 1) {
      const text = after
        .slice(1)
        .map((w) => w.text)
        .join(' ')
      placed.push({ i: hero + 2, text, x: ax - hw * 0.38, y: ay + base * 0.42, align: 'left', font: smallFont, hero: false, hot: false })
    }
  }

  // Keep the block inside the frame.
  let minX = Infinity
  let maxX = -Infinity
  for (const p of placed) {
    ctx.font = p.font
    const w = ctx.measureText(p.text).width
    const x0 = p.align === 'center' ? p.x - w / 2 : p.align === 'right' ? p.x - w : p.x
    minX = Math.min(minX, x0)
    maxX = Math.max(maxX, x0 + w)
  }
  const margin = 40 * u
  const shift = minX < margin ? margin - minX : maxX > W - margin ? W - margin - maxX : 0

  const stepW = Math.min(0.22, ((line.end - line.start) * 0.7) / n)
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  for (const p of placed.sort((a, b) => Number(a.hero) - Number(b.hero))) {
    const appear = line.start + Math.max(0, p.i) * stepW
    const k = Math.min(1, Math.max(0, (f.t - appear) / 0.12))
    if (k <= 0) continue
    const g = f.r('capword', li, p.i)
    const sc = 1 + (1 - ease(k)) * 0.35
    ctx.save()
    ctx.translate(p.x + shift + g.range(-1.5, 1.5) * u, p.y + g.range(-1.5, 1.5) * u)
    ctx.rotate(g.range(-0.012, 0.012) + (p.hero ? lr.range(-0.02, 0.02) : 0))
    ctx.scale(sc, sc)
    ctx.globalAlpha = k
    ctx.font = p.font
    ctx.textAlign = p.align
    if (p.hot) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = (p.hero ? base : small) * 0.09
      ctx.strokeText(p.text, 0, 0)
      ctx.fillStyle = s.accent
      ctx.fillText(p.text, 0, 0)
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = 10 * u
      ctx.shadowOffsetY = 2 * u
      ctx.fillStyle = s.color
      ctx.fillText(p.text, 0, 0)
    }
    ctx.restore()
  }
  ctx.restore()
}

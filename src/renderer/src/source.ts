import type { MaskData } from './vision/Vision'
import type { ShapeImage, Still } from './core/frame'
import { labelComponents, ringBounds, traceBlob, boxBlur } from './core/mask'
import { canvas } from './core/paper'

const VIDEO_RE = /\.(mp4|mov|webm|m4v|mkv)$/i

/**
 * Seek and wait until the new frame is actually presented. 'seeked' alone can fire before the decoder
 * has the frame (from glitch-chain/src/renderer/src/export/OfflineRender.ts).
 */
export function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return resolve()
    let finished = false
    const done = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 3000)
    v.requestVideoFrameCallback(() => done())
    v.currentTime = t
  })
}

function waitMeta(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (v.readyState >= 2) return resolve()
    v.addEventListener('loadeddata', () => resolve(), { once: true })
    v.addEventListener('error', () => reject(new Error('This video could not be decoded (try H.264 MP4).')), { once: true })
  })
}

async function blobUrl(path: string): Promise<{ url: string; blob: Blob }> {
  const f = await window.api.readFile(path)
  const blob = new Blob([f.data])
  return { url: URL.createObjectURL(blob), blob }
}

/** Max long side for the working source frame (export quality vs speed). */
const MAX_SRC = 1920

export class Source {
  kind: 'video' | 'image' | null = null
  path = ''
  name = ''
  url = ''
  video: HTMLVideoElement
  w = 0
  h = 0
  fps = 30
  duration = 0
  hasAudio = false
  /** The current source frame, at working resolution. */
  frame: HTMLCanvasElement = canvas(2, 2)
  private image: ImageBitmap | null = null

  constructor() {
    this.video = document.createElement('video')
    this.video.muted = false
    this.video.playsInline = true
    this.video.loop = true
    this.video.preload = 'auto'
  }

  get ready(): boolean {
    return this.kind !== null
  }

  async load(path: string, file?: File): Promise<void> {
    const isVideo = VIDEO_RE.test(path || file?.name || '')
    const { url, blob } = file ? { url: URL.createObjectURL(file), blob: file as Blob } : await blobUrl(path)
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = url
    this.path = path
    this.name = (path || file?.name || '').split(/[\\/]/).pop() ?? ''
    this.image?.close()
    this.image = null
    if (isVideo) {
      this.video.src = url
      await waitMeta(this.video)
      this.kind = 'video'
      this.w = this.video.videoWidth
      this.h = this.video.videoHeight
      this.duration = this.video.duration
      const probe = path ? await window.api.probe(path) : { fps: 30, audio: true, duration: this.duration }
      this.fps = probe.fps
      this.hasAudio = probe.audio
    } else {
      this.video.removeAttribute('src')
      this.video.load()
      this.image = await createImageBitmap(blob)
      this.kind = 'image'
      this.w = this.image.width
      this.h = this.image.height
      this.duration = 5
      this.fps = 30
      this.hasAudio = false
    }
    // Stills keep up to 4K (background removal of photos); video works at 1920.
    const k = Math.min(1, (this.kind === 'image' ? 4096 : MAX_SRC) / Math.max(this.w, this.h))
    this.frame = canvas(this.w * k, this.h * k)
    this.draw()
  }

  /** Copy the current video frame (or the still) into `frame`. */
  draw(): void {
    const ctx = this.frame.getContext('2d')!
    const img = this.kind === 'video' ? this.video : this.image
    if (img) ctx.drawImage(img, 0, 0, this.frame.width, this.frame.height)
  }

  async seek(t: number): Promise<void> {
    if (this.kind !== 'video') return
    await seekVideo(this.video, Math.min(t, Math.max(0, this.duration - 0.001)))
    this.draw()
  }

  /** `n` frames spread across the video (for time slip and fallback fills). */
  async snapshots(n: number, maxSide = 960): Promise<Still[]> {
    if (this.kind === 'image') return this.image ? [await createImageBitmap(this.image)] : []
    if (this.kind !== 'video') return []
    return extractFrames(this.url, this.duration, n, maxSide)
  }
}

async function extractFrames(url: string, duration: number, n: number, maxSide: number): Promise<Still[]> {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = url
  await waitMeta(v)
  const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight))
  const out: Still[] = []
  for (let i = 0; i < n; i++) {
    await seekVideo(v, ((i + 0.5) / n) * Math.max(0.01, (duration || v.duration) - 0.05))
    const c = canvas(v.videoWidth * k, v.videoHeight * k)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    out.push(c)
  }
  v.removeAttribute('src')
  v.load()
  return out
}

/** The HQ matte track: a grayscale mask video played/sought in sync with the source (or one mask image for a still). */
export class MatteTrack {
  video: HTMLVideoElement | null = null
  still: HTMLCanvasElement | null = null
  path = ''
  /** Which HQ engine produced the loaded matte. */
  engine = ''
  private c = canvas(2, 2)
  private url = ''
  private last: { key: string; m: MaskData } | null = null

  async load(path: string): Promise<void> {
    this.unload()
    if (/\.png$/i.test(path)) {
      const f = await window.api.readFile(path)
      const bmp = await createImageBitmap(new Blob([f.data]))
      const c = canvas(bmp.width, bmp.height)
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
      this.still = c
      this.path = path
      return
    }
    const { url } = await blobUrl(path)
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = url
    await waitMeta(v)
    this.video = v
    this.url = url
    this.path = path
  }

  unload(): void {
    if (this.video) {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    }
    if (this.url) URL.revokeObjectURL(this.url)
    this.video = null
    this.still = null
    this.last = null
    this.url = ''
    this.path = ''
  }

  get ready(): boolean {
    return !!this.video || !!this.still
  }

  seek(t: number): Promise<void> {
    return this.video ? seekVideo(this.video, Math.min(t, Math.max(0, this.video.duration - 0.001))) : Promise.resolve()
  }

  /** Follow the playing source loosely (preview); export uses exact seeks. */
  follow(t: number, playing: boolean): void {
    const v = this.video
    if (!v) return
    if (playing) {
      if (v.paused) void v.play().catch(() => {})
      if (Math.abs(v.currentTime - t) > 0.12) v.currentTime = t
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - t) > 0.01) v.currentTime = t
    }
  }

  read(maxSide = 512): MaskData | null {
    const v: HTMLVideoElement | HTMLCanvasElement | null = this.still ?? this.video
    if (!v || (v instanceof HTMLVideoElement && v.readyState < 2)) return null
    const vw = v instanceof HTMLVideoElement ? v.videoWidth : v.width
    const vh = v instanceof HTMLVideoElement ? v.videoHeight : v.height
    // Same frame, same size: hand back the same mask object (downstream caches key on identity).
    const key = `${v instanceof HTMLVideoElement ? v.currentTime : 'still'}|${maxSide}|${this.path}`
    if (this.last && this.last.key === key) return this.last.m
    const k = Math.min(1, maxSide / Math.max(vw, vh))
    const w = Math.max(1, Math.round(vw * k))
    const h = Math.max(1, Math.round(vh * k))
    if (this.c.width !== w || this.c.height !== h) this.c = canvas(w, h)
    const ctx = this.c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(v, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    const data = new Uint8Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = px[i * 4]
    const m = { w, h, data }
    this.last = { key, m }
    return m
  }
}

// ---------- fill library ----------

export async function loadLibrary(paths: string[], onProgress: (done: number, total: number) => void): Promise<Still[]> {
  const out: Still[] = []
  const list = paths.slice(0, 120)
  for (let i = 0; i < list.length && out.length < 160; i++) {
    const p = list[i]
    try {
      if (VIDEO_RE.test(p)) {
        const { url } = await blobUrl(p)
        out.push(...(await extractFrames(url, 0, 6, 1280)))
        URL.revokeObjectURL(url)
      } else {
        const f = await window.api.readFile(p)
        const bmp = await createImageBitmap(new Blob([f.data]))
        const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height))
        out.push(k < 1 ? await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' }) : bmp)
      }
    } catch {
      // unreadable file: skip
    }
    onProgress(i + 1, list.length)
  }
  return out
}

// ---------- shape images (FILL) ----------

function maskFromPixels(px: Uint8ClampedArray, w: number, h: number): MaskData {
  const data = new Uint8Array(w * h)
  let transparent = 0
  for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] < 128) transparent++
  if (transparent > w * h * 0.01) {
    for (let i = 0; i < w * h; i++) data[i] = px[i * 4 + 3]
    return { w, h, data }
  }
  // Opaque image: key out the border color (product shots on white / flat backgrounds).
  const border: number[][] = []
  for (let x = 0; x < w; x += 4) border.push([0, x], [h - 1, x])
  for (let y = 0; y < h; y += 4) border.push([y, 0], [y, w - 1])
  const cols = border.map(([y, x]) => [px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2]])
  const med = [0, 1, 2].map((c) => cols.map((v) => v[c]).sort((a, b) => a - b)[cols.length >> 1])
  for (let i = 0; i < w * h; i++) {
    const d = Math.hypot(px[i * 4] - med[0], px[i * 4 + 1] - med[1], px[i * 4 + 2] - med[2])
    data[i] = Math.max(0, Math.min(255, (d - 26) * 6))
  }
  return { w, h, data }
}

async function pixels(blob: Blob, maxSide: number): Promise<{ px: Uint8ClampedArray; w: number; h: number }> {
  const bmp = await createImageBitmap(blob)
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const c = canvas(bmp.width * k, bmp.height * k)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }
}

export function shapeFromMask(name: string, m: MaskData): ShapeImage | null {
  const mm = boxBlur(m, 1)
  const { labels, blobs } = labelComponents(mm, 0.5, mm.w * mm.h * 0.004)
  const rings = blobs.flatMap((b) => traceBlob(mm, labels, b, 0.5))
  if (!rings.length) return null
  const bb = ringBounds(rings)
  const bw = bb.x1 - bb.x0
  const bh = bb.y1 - bb.y0
  return { name, aspect: bw / bh, rings: rings.map((r) => r.map(([x, y]) => [(x - bb.x0) / bw, (y - bb.y0) / bh])) }
}

/** Outline of an image's subject: its alpha if it has one, else HQ matte (GPU), else a border-color key. */
export async function loadShapeImage(path: string, useMatte: boolean): Promise<ShapeImage | null> {
  const name = path.split(/[\\/]/).pop() ?? path
  const f = await window.api.readFile(path)
  const { px, w, h } = await pixels(new Blob([f.data]), 512)
  let m = maskFromPixels(px, w, h)
  const hasAlpha = (() => {
    for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 128) return true
    return false
  })()
  if (!hasAlpha && useMatte) {
    try {
      const out = await window.api.matteRun(path, 'saliency')
      const mf = await window.api.readFile(out)
      const mp = await pixels(new Blob([mf.data]), 512)
      const data = new Uint8Array(mp.w * mp.h)
      for (let i = 0; i < data.length; i++) data[i] = mp.px[i * 4]
      m = { w: mp.w, h: mp.h, data }
    } catch {
      // keep the color key
    }
  }
  return shapeFromMask(name, m)
}

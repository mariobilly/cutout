import { FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { Face, MaskData, ModelUrls, Needs, PersonModel, VisionResult } from './types'

// Ported from glitch-chain/src/renderer/src/vision/engine.ts (person + face only).

type Img = ImageBitmap | OffscreenCanvas

interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
  eyes: { x: number; y: number }[] | null
}

const iou = (a: Box, b: Box): number => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

const MAX_FACES = 4

export class VisionEngine {
  private detector: FaceDetector | null = null
  private seg: Partial<Record<PersonModel, ImageSegmenter>> = {}
  private loading = new Map<string, Promise<void>>()
  devices: Record<string, 'GPU' | 'CPU'> = {}

  private faces: Face[] = []
  private missed = 0
  private crop = new OffscreenCanvas(256, 256)

  constructor(
    private urls: ModelUrls,
    private status: (s: string) => void
  ) {}

  has(need: Needs): boolean {
    return (!need.face || !!this.detector) && (!need.person || !!this.seg[need.model])
  }

  ensure(need: Needs): Promise<void> {
    const jobs: Promise<void>[] = []
    if (need.face && !this.detector) jobs.push(this.load('face'))
    if (need.person && !this.seg[need.model]) jobs.push(this.load(need.model))
    return Promise.all(jobs).then(() => {})
  }

  private load(kind: 'face' | PersonModel): Promise<void> {
    let p = this.loading.get(kind)
    if (p) return p
    this.status(`loading ${kind} model…`)
    const fileset = { wasmLoaderPath: this.urls.loader, wasmBinaryPath: this.urls.wasm }
    const bytes = async (url: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(url)).arrayBuffer())
    const create = async <T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> => {
      try {
        const m = await make('GPU')
        this.devices[kind] = 'GPU'
        return m
      } catch {
        const m = await make('CPU')
        this.devices[kind] = 'CPU'
        return m
      }
    }
    p = (async () => {
      if (kind === 'face') {
        const buf = await bytes(this.urls.face)
        this.detector = await create((delegate) =>
          FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: buf, delegate }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 })
        )
      } else {
        const buf = await bytes(kind === 'selfie' ? this.urls.selfie : this.urls.multiclass)
        this.seg[kind] = await create((delegate) =>
          ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: buf, delegate },
            runningMode: 'IMAGE',
            outputConfidenceMasks: true,
            outputCategoryMask: false
          })
        )
      }
    })()
      .catch((err) => this.status(`${kind} model failed: ${(err as Error).message}`))
      .finally(() => {
        this.loading.delete(kind)
        if (!this.loading.size) this.status('')
      })
    this.loading.set(kind, p)
    return p
  }

  reset(): void {
    this.faces = []
    this.missed = 0
  }

  analyze(img: ImageBitmap, w: number, h: number, need: Needs, smooth = 0.5): VisionResult {
    const out: VisionResult = { faces: this.faces }
    if (need.face && this.detector) this.detectFaces(img, w, h, smooth)
    if (need.person && this.seg[need.model]) out.person = this.personMask(img, need.model)
    return { ...out, faces: this.faces }
  }

  // ---------- segmentation ----------

  private personMask(img: Img, model: PersonModel): MaskData | undefined {
    const res = this.seg[model]!.segment(img)
    try {
      const ms = res.confidenceMasks
      if (!ms?.length) return
      if (model === 'multiclass') {
        // 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 accessories: person = 1 - background.
        const bg = ms[0].getAsFloat32Array()
        const data = new Uint8Array(bg.length)
        for (let i = 0; i < bg.length; i++) data[i] = (1 - bg[i]) * 255
        return { w: ms[0].width, h: ms[0].height, data }
      }
      const f = ms[0].getAsFloat32Array()
      const data = new Uint8Array(f.length)
      for (let i = 0; i < f.length; i++) data[i] = f[i] * 255
      return { w: ms[0].width, h: ms[0].height, data }
    } finally {
      res.close()
    }
  }

  // ---------- faces ----------

  /** Detect in a sub-rectangle (scaled to the model's comfort zone); returns boxes in full-image pixels. */
  private detectIn(img: Img, sx: number, sy: number, sw: number, sh: number, full: boolean): Box[] {
    let src: Img = img
    let scale = 1
    if (!full) {
      const S = 256
      const g = this.crop.getContext('2d')!
      g.clearRect(0, 0, S, S)
      g.drawImage(img, sx, sy, sw, sh, 0, 0, S, S)
      src = this.crop
      scale = sw / S
    }
    const res = this.detector!.detect(src)
    return res.detections
      .filter((d) => d.boundingBox)
      .map((d) => {
        const bb = d.boundingBox!
        const pts = d.keypoints.map((k) => ({ x: sx + k.x * sw, y: sy + k.y * sh }))
        return {
          x: sx + bb.originX * scale,
          y: sy + bb.originY * scale,
          w: bb.width * scale,
          h: bb.height * scale,
          score: d.categories[0]?.score ?? 0,
          eyes: pts.length >= 2 ? [pts[0], pts[1]] : null
        }
      })
  }

  /** Face search: crops around last frame's faces, then the whole frame, then zoomed overlapping tiles. */
  private findFaces(img: Img, w: number, h: number): Box[] {
    let boxes: Box[] = []
    for (const f of this.faces) {
      const side = Math.min(Math.max(w, h), Math.max(f.rx * w, f.ry * h) * 2 * 2.2)
      const sx = Math.max(0, Math.min(w - side, f.cx * w - side / 2))
      const sy = Math.max(0, Math.min(h - side, f.cy * h - side / 2))
      boxes.push(...this.detectIn(img, sx, sy, Math.min(side, w), Math.min(side, h), false))
    }
    if (!boxes.length) boxes = this.detectIn(img, 0, 0, w, h, true)
    if (!boxes.length) {
      const side = Math.min(w, h) / 1.5
      const step = side * 0.66
      for (let y = 0; y < h - 1; y += step) {
        for (let x = 0; x < w - 1; x += step) {
          boxes.push(...this.detectIn(img, Math.min(x, w - side), Math.min(y, h - side), side, side, false))
          if (x + side >= w) break
        }
        if (y + side >= h) break
      }
    }
    boxes.sort((a, b) => b.score - a.score)
    const keep: Box[] = []
    for (const bx of boxes) if (!keep.some((k) => iou(k, bx) > 0.3)) keep.push(bx)
    return keep
  }

  private detectFaces(img: Img, w: number, h: number, smooth: number): void {
    const found: Face[] = this.findFaces(img, w, h)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, MAX_FACES)
      .map((b) => {
        const angle = b.eyes ? Math.atan2(b.eyes[1].y - b.eyes[0].y, b.eyes[1].x - b.eyes[0].x) : 0
        return { cx: (b.x + b.w / 2) / w, cy: (b.y + b.h * 0.42) / h, rx: (b.w * 0.62) / w, ry: (b.h * 0.78) / h, angle }
      })
    if (!found.length) {
      if (++this.missed > 8) this.faces = []
      return
    }
    this.missed = 0
    this.faces = found.map((f) => {
      const prev = this.faces.reduce<Face | null>((best, p) => {
        const d = Math.hypot(p.cx - f.cx, p.cy - f.cy)
        return d < 0.15 && (!best || d < Math.hypot(best.cx - f.cx, best.cy - f.cy)) ? p : best
      }, null)
      if (!prev) return f
      const m = (a: number, b: number): number => a * smooth + b * (1 - smooth)
      return { cx: m(prev.cx, f.cx), cy: m(prev.cy, f.cy), rx: m(prev.rx, f.rx), ry: m(prev.ry, f.ry), angle: m(prev.angle, f.angle) }
    })
  }
}

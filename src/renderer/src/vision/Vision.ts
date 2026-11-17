import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import faceModelUrl from '../assets/models/blaze_face_short_range.tflite?url'
import selfieModelUrl from '../assets/models/selfie_segmenter.tflite?url'
import multiModelUrl from '../assets/models/selfie_multiclass_256x256.tflite?url'
import VisionWorker from './vision.worker?worker'
import type { Needs, VisionResult } from './types'

export type { Face, MaskData, Needs, PersonModel, VisionResult } from './types'

// Absolute URLs: the worker resolves relative paths against its own script location, not the page.
const abs = (u: string): string => new URL(u, document.baseURI).href

type Out =
  | { type: 'status'; text: string }
  | { type: 'done'; id: number; ready?: boolean; devices?: Record<string, 'GPU' | 'CPU'> }
  | { type: 'result'; id: number; result: VisionResult }
  | { type: 'error'; id: number; message: string }

/**
 * Main-thread face of the vision worker. The live preview calls `analyze` only when idle (latest frame wins);
 * the offline render awaits it for every frame so the output is exact.
 */
export class Vision {
  status = ''
  devices: Record<string, 'GPU' | 'CPU'> = {}
  onStatus: (s: string) => void = () => {}
  busy = false
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor() {
    this.worker = new VisionWorker()
    this.worker.onmessage = (e: MessageEvent<Out>) => {
      const m = e.data
      if (m.type === 'status') {
        this.status = m.text
        this.onStatus(m.text)
        return
      }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.type === 'error') p.reject(new Error(m.message))
      else if (m.type === 'result') p.resolve(m.result)
      else {
        if (m.devices) this.devices = m.devices
        p.resolve(m.ready ?? true)
      }
    }
    this.worker.postMessage({
      type: 'init',
      urls: {
        loader: abs(wasmLoaderPath),
        wasm: abs(wasmBinaryPath),
        face: abs(faceModelUrl),
        selfie: abs(selfieModelUrl),
        multiclass: abs(multiModelUrl)
      }
    })
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ ...msg, id }, transfer)
    })
  }

  ensure(need: Needs): Promise<boolean> {
    return this.call<boolean>({ type: 'ensure', need })
  }

  reset(): Promise<void> {
    return this.call<void>({ type: 'reset' })
  }

  /** Analyze a frame (source drawn into `src`), at most `maxSide` px on the long side. */
  async analyze(src: CanvasImageSource, w: number, h: number, need: Needs, smooth = 0.5, maxSide = 512): Promise<VisionResult> {
    const k = Math.min(1, maxSide / Math.max(w, h))
    const bw = Math.max(1, Math.round(w * k))
    const bh = Math.max(1, Math.round(h * k))
    const bitmap = await createImageBitmap(src as ImageBitmapSource, { resizeWidth: bw, resizeHeight: bh, resizeQuality: 'high' })
    this.busy = true
    try {
      return await this.call<VisionResult>({ type: 'analyze', bitmap, w: bw, h: bh, need, smooth }, [bitmap])
    } finally {
      this.busy = false
    }
  }
}

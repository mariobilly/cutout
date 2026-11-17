/// <reference lib="webworker" />
// Runs all MediaPipe detection off the main thread. Bundled as a classic (iife) worker because MediaPipe's
// WASM loader uses importScripts(), which module workers don't have.
import { VisionEngine } from './engine'
import type { ModelUrls, Needs, VisionResult } from './types'

type In =
  | { type: 'init'; urls: ModelUrls }
  | { type: 'ensure'; id: number; need: Needs }
  | { type: 'analyze'; id: number; bitmap: ImageBitmap; w: number; h: number; need: Needs; smooth: number }
  | { type: 'reset'; id: number }

const scope = self as unknown as DedicatedWorkerGlobalScope
let engine: VisionEngine | null = null

scope.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      engine = new VisionEngine(m.urls, (text) => scope.postMessage({ type: 'status', text }))
      return
    }
    if (!engine) throw new Error('vision worker not initialized')
    if (m.type === 'ensure') {
      await engine.ensure(m.need)
      scope.postMessage({ type: 'done', id: m.id, ready: engine.has(m.need), devices: engine.devices })
    } else if (m.type === 'reset') {
      engine.reset()
      scope.postMessage({ type: 'done', id: m.id })
    } else if (m.type === 'analyze') {
      let result: VisionResult
      try {
        result = engine.analyze(m.bitmap, m.w, m.h, m.need, m.smooth)
      } finally {
        m.bitmap.close()
      }
      const transfer: Transferable[] = result.person ? [result.person.data.buffer] : []
      scope.postMessage({ type: 'result', id: m.id, result }, transfer)
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: 'id' in m ? m.id : -1, message: (err as Error).message })
  }
}

import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type Codec = 'h264' | 'prores4444' | 'webm' | 'png'
export type MatteEngine = 'saliency' | 'people'

export interface Autoload {
  load: string
  style: string
  preset: string
  params: string
  time: number
  play: number
  random: number
  fillDir: string
  shapes: string
  hq: string
  shot: string
  exportPath: string
  exportSeconds: number
  exportCodec: string
  exportTransparent: boolean
  fresh: boolean
}

const api = {
  pathForFile: (f: File): string => {
    try {
      return webUtils.getPathForFile(f)
    } catch {
      return ''
    }
  },
  readFile: (p: string): Promise<{ name: string; data: ArrayBuffer }> => ipcRenderer.invoke('read-file', p),
  chooseFiles: (title: string, kind: 'media' | 'image', multi = false): Promise<string[]> => ipcRenderer.invoke('file:choose', title, kind, multi),
  chooseFolder: (title: string): Promise<string | null> => ipcRenderer.invoke('folder:choose', title),
  folderMedia: (dir: string): Promise<string[]> => ipcRenderer.invoke('folder:media', dir),
  probe: (p: string): Promise<{ fps: number; duration: number; audio: boolean }> => ipcRenderer.invoke('probe', p),
  saveFile: (name: string, filters: { name: string; extensions: string[] }[], data: ArrayBuffer): Promise<string | null> =>
    ipcRenderer.invoke('save-file', name, filters, data),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('reveal', p),

  renderChoose: (defaultName: string, codec: Codec): Promise<string | null> => ipcRenderer.invoke('render:choose', defaultName, codec),
  renderStart: (o: {
    out: string
    width: number
    height: number
    fps: number
    duration: number
    codec: Codec
    audioPath?: string
    audioOffset?: number
  }): Promise<boolean> => ipcRenderer.invoke('render:start', o),
  renderFrame: (px: Uint8Array): Promise<void> => ipcRenderer.invoke('render:frame', px),
  renderFinish: (): Promise<string> => ipcRenderer.invoke('render:finish'),
  renderCancel: (): Promise<void> => ipcRenderer.invoke('render:cancel'),

  matteCached: (src: string, engine: MatteEngine): Promise<string> => ipcRenderer.invoke('matte:cached', src, engine),
  matteRun: (src: string, engine: MatteEngine): Promise<string> => ipcRenderer.invoke('matte:run', src, engine),
  matteCancel: (): Promise<void> => ipcRenderer.invoke('matte:cancel'),
  onMatteProgress: (fn: (done: number, total: number) => void): void => {
    ipcRenderer.on('matte:progress', (_e, d: number, t: number) => fn(d, t))
  },
  onMatteStatus: (fn: (text: string) => void): void => {
    ipcRenderer.on('matte:status', (_e, s: string) => fn(s))
  },

  autoload: (): Promise<Autoload> => ipcRenderer.invoke('autoload'),
  shot: (path: string): Promise<void> => ipcRenderer.invoke('shot', path),
  quit: (): Promise<void> => ipcRenderer.invoke('quit')
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)

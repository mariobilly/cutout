import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, basename, extname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'

// When packaged, the binary lives in app.asar.unpacked (see build.asarUnpack).
const ffmpegPath = String(ffmpegStatic ?? 'ffmpeg').replace('app.asar', 'app.asar.unpacked')

// Tests point this at a throwaway folder so they never touch the user's saved settings.
if (process.env.CUTOUT_USER_DATA) app.setPath('userData', process.env.CUTOUT_USER_DATA)

let win: BrowserWindow | null = null

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', 'mkv']

function createWindow(): void {
  const devIcon = join(app.getAppPath(), 'build', 'icon.ico')
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0d0d0f',
    title: 'CUTOUT',
    autoHideMenuBar: true,
    icon: existsSync(devIcon) ? devIcon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  // CUTOUT_DEBUG=1 mirrors the renderer console to stdout (tests read it).
  if (process.env.CUTOUT_DEBUG) {
    win.webContents.on('console-message', (...a: unknown[]) => {
      const e = a[0] as { message?: string }
      console.log('[renderer]', e?.message ?? a[2])
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  // Safety net for the screenshot hook: if the renderer never reports ready, capture anyway.
  const shot = process.env.CUTOUT_SHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void captureAndQuit(shot), Number(process.env.CUTOUT_SHOT_TIMEOUT || 90000))
    })
  }
}

async function captureAndQuit(path: string): Promise<void> {
  if (!win) return
  const img = await win.webContents.capturePage()
  await fs.writeFile(path, img.toPNG())
  app.quit()
}

// ---------- files ----------

ipcMain.handle('read-file', async (_e, p: string) => {
  const buf = await fs.readFile(p)
  return { name: basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
})

ipcMain.handle('file:choose', async (_e, title: string, kind: 'media' | 'image', multi: boolean) => {
  const exts = kind === 'image' ? IMAGE_EXT : [...VIDEO_EXT, ...IMAGE_EXT]
  const r = await dialog.showOpenDialog(win!, {
    title,
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: kind === 'image' ? 'Images' : 'Video or image', extensions: exts }]
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('folder:choose', async (_e, title: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

/** Images and videos directly inside a folder, sorted by name. */
ipcMain.handle('folder:media', async (_e, dir: string) => {
  const names = await fs.readdir(dir)
  return names
    .filter((n) => [...IMAGE_EXT, ...VIDEO_EXT].includes(extname(n).slice(1).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => join(dir, n))
})

/** Duration, fps and whether there is an audio stream, read from ffmpeg's banner. */
ipcMain.handle('probe', (_e, p: string) => {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', p], { windowsHide: true })
    let log = ''
    proc.stderr.on('data', (d) => (log += d.toString()))
    proc.on('error', () => resolve({ fps: 30, duration: 0, audio: false }))
    proc.on('close', () => {
      const fps = Number(/,\s*([\d.]+)\s*fps/.exec(log)?.[1] ?? 30)
      const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log)
      const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
      resolve({ fps: fps > 0 && fps < 240 ? fps : 30, duration, audio: /Stream #.*Audio:/.test(log) })
    })
  })
})

ipcMain.handle('save-file', async (_e, defaultName: string, filters: Electron.FileFilter[], data: ArrayBuffer) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters })
  if (r.canceled || !r.filePath) return null
  await fs.writeFile(r.filePath, Buffer.from(data))
  return r.filePath
})

ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p))

// ---------- offline render: renderer pushes raw RGBA frames, ffmpeg encodes from stdin ----------

type Codec = 'h264' | 'prores4444' | 'webm' | 'png'

interface RenderOpts {
  out: string
  width: number
  height: number
  fps: number
  duration: number
  codec: Codec
  audioPath?: string
  audioOffset?: number
}

const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
const CODEC_ARGS: Record<Codec, string[]> = {
  h264: ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', ...BT709, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  // 4444 keeps the alpha channel: a transparent cutout layer for Premiere / After Effects.
  prores4444: ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', ...BT709, '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0'],
  // VP9 with alpha: small transparent video for web / CapCut / OBS.
  webm: ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', ...BT709, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3', '-auto-alt-ref', '0'],
  png: ['-c:v', 'png', '-pix_fmt', 'rgba']
}
const CODEC_EXT: Record<Codec, { name: string; ext: string }> = {
  h264: { name: 'MP4 (H.264)', ext: 'mp4' },
  prores4444: { name: 'QuickTime (ProRes 4444 + alpha)', ext: 'mov' },
  webm: { name: 'WebM (VP9 + alpha)', ext: 'webm' },
  png: { name: 'PNG sequence (folder)', ext: '' }
}
const AUDIO_ARGS: Record<Codec, string[]> = {
  h264: ['-c:a', 'aac', '-b:a', '320k'],
  prores4444: ['-c:a', 'pcm_s16le'],
  webm: ['-c:a', 'libopus', '-b:a', '192k'],
  png: []
}

let session: { proc: ChildProcessWithoutNullStreams; out: string; png: boolean; done: Promise<void>; log: () => string } | null = null

ipcMain.handle('render:choose', async (_e, defaultName: string, codec: Codec) => {
  const { name, ext } = CODEC_EXT[codec]
  // PNG sequence: the chosen name becomes a folder of numbered frames.
  const r = await dialog.showSaveDialog(win!, {
    title: codec === 'png' ? 'Name the folder for the PNG frames' : undefined,
    defaultPath: ext ? `${defaultName}.${ext}` : `${defaultName}_frames`,
    filters: ext ? [{ name, extensions: [ext] }] : []
  })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('render:start', async (_e, o: RenderOpts) => {
  if (session) session.proc.kill('SIGKILL')
  let target = o.out
  if (o.codec === 'png') {
    await fs.mkdir(o.out, { recursive: true })
    target = join(o.out, `${basename(o.out)}_%05d.png`)
  }
  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', '-']
  const audio = o.audioPath && o.codec !== 'png'
  if (audio) {
    if (o.audioOffset) args.push('-ss', String(o.audioOffset))
    args.push('-i', o.audioPath!, '-map', '0:v:0', '-map', '1:a:0?')
  }
  args.push(...CODEC_ARGS[o.codec])
  if (audio) args.push(...AUDIO_ARGS[o.codec])
  args.push('-t', String(o.duration), target)

  const proc = spawn(ffmpegPath, args, { windowsHide: true })
  let log = ''
  proc.stderr.on('data', (d) => (log = (log + d.toString()).slice(-4000)))
  proc.stdin.on('error', () => {}) // surfaced via frame write callbacks / exit code
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}
${log}`))))
  })
  done.catch(() => {})
  session = { proc, out: o.out, png: o.codec === 'png', done, log: () => log }
  return true
})

ipcMain.handle('render:frame', (_e, data: Uint8Array) => {
  const s = session
  if (!s) throw new Error('No render in progress')
  return new Promise<void>((resolve, reject) => {
    s.proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err) =>
      err ? reject(new Error(`Encoder stopped: ${err.message}\n${s.log()}`)) : resolve()
    )
  })
})

ipcMain.handle('render:finish', async () => {
  const s = session
  if (!s) throw new Error('No render in progress')
  s.proc.stdin.end()
  try {
    await s.done
  } finally {
    session = null
  }
  return s.out
})

ipcMain.handle('render:cancel', async () => {
  const s = session
  session = null
  if (!s) return
  s.proc.kill('SIGKILL')
  await s.done.catch(() => {})
  if (s.png) {
    // Only remove the frames this render wrote; leave anything else in the folder alone.
    const prefix = `${basename(s.out)}_`
    const names = await fs.readdir(s.out).catch(() => [] as string[])
    await Promise.all(names.filter((n) => n.startsWith(prefix) && n.endsWith('.png')).map((n) => fs.unlink(join(s.out, n)).catch(() => {})))
    await fs.rmdir(s.out).catch(() => {}) // only succeeds if now empty
  } else await fs.unlink(s.out).catch(() => {})
})

// ---------- HQ matte (optional): Python + transparent-background (InSPyReNet) on CUDA ----------

type MatteEngine = 'saliency' | 'people'

const toolPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'tools', 'hq_matte.py') : join(app.getAppPath(), 'tools', 'hq_matte.py')

/** The Python that runs tools/hq_matte.py: CUTOUT_PYTHON if set, else `python` on the PATH. */
function pythonExe(): string {
  return process.env.CUTOUT_PYTHON?.trim().replace(/^"(.*)"$/, '$1') || 'python'
}

/** Errors starting with this mean the optional HQ matte isn't installed; the renderer then stops trying it on its own. */
const NOT_SET_UP = 'HQ matte is not set up'
const noPython = (): Error =>
  new Error(`${NOT_SET_UP}: Python was not found (${pythonExe()}). Install it with the packages in requirements.txt, or set CUTOUT_PYTHON. Using the live mask.`)

async function mattePath(src: string, engine: MatteEngine): Promise<string> {
  const st = await fs.stat(src)
  const key = createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${engine}|v2`).digest('hex').slice(0, 16)
  const isImage = IMAGE_EXT.includes(extname(src).slice(1).toLowerCase())
  const dir = join(app.getPath('userData'), 'mattes')
  await fs.mkdir(dir, { recursive: true })
  return join(dir, `${key}.${isImage ? 'png' : 'mp4'}`)
}

ipcMain.handle('matte:cached', async (_e, src: string, engine: MatteEngine) => {
  const out = await mattePath(src, engine)
  return existsSync(out) ? out : ''
})

let matteProc: ChildProcess | null = null

ipcMain.handle('matte:run', async (e, src: string, engine: MatteEngine) => {
  const out = await mattePath(src, engine)
  if (existsSync(out)) return out
  matteProc?.kill()
  const tmp = out.replace(/(\.\w+)$/, '.part$1')
  return new Promise<string>((resolve, reject) => {
    const models = join(app.getPath('userData'), 'models')
    const args = ['-u', toolPath(), '--src', src, '--out', tmp, '--engine', engine, '--ffmpeg', ffmpegPath, '--models', models]
    const proc = spawn(pythonExe(), args, { windowsHide: true })
    matteProc = proc
    let log = ''
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^PROGRESS (\d+)\/(\d+)/.exec(line)
        if (m) e.sender.send('matte:progress', Number(m[1]), Number(m[2]))
        else if (line.startsWith('STATUS ')) e.sender.send('matte:status', line.slice(7))
        else log = (log + line + '\n').slice(-4000)
      }
    })
    proc.stderr.on('data', (d) => (log = (log + d.toString()).slice(-4000)))
    proc.on('error', (err) =>
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? noPython() : new Error(`Could not start Python (${pythonExe()}): ${err.message}`))
    )
    proc.on('close', async (code) => {
      if (matteProc === proc) matteProc = null
      if (code === 0 && existsSync(tmp)) {
        await fs.rename(tmp, out)
        resolve(out)
        return
      }
      await fs.unlink(tmp).catch(() => {})
      const why = /NOT SET UP: (.*)/.exec(log)?.[1]?.trim()
      if (code === null) reject(new Error('HQ matte cancelled'))
      // 4: hq_matte.py found a missing package or weights. 9009: Windows' "python" placeholder (no Python installed).
      else if (code === 4 && why) reject(new Error(`${NOT_SET_UP}: ${why}. Using the live mask.`))
      else if (code === 9009) reject(noPython())
      else reject(new Error(`HQ matte failed (exit ${code})\n${log.trim().split('\n').slice(-6).join('\n')}`))
    })
  })
})

ipcMain.handle('matte:cancel', () => {
  matteProc?.kill()
  matteProc = null
})

// ---------- test / automation hooks ----------

ipcMain.handle('autoload', () => ({
  load: process.env.CUTOUT_LOAD || '',
  style: process.env.CUTOUT_STYLE || '',
  preset: process.env.CUTOUT_PRESET || '',
  params: process.env.CUTOUT_PARAMS || '',
  time: Number(process.env.CUTOUT_TIME || 0),
  play: Number(process.env.CUTOUT_PLAY || 0),
  random: Number(process.env.CUTOUT_RANDOM || 0),
  fillDir: process.env.CUTOUT_FILL_DIR || '',
  shapes: process.env.CUTOUT_SHAPES || '',
  hq: process.env.CUTOUT_HQ || '',
  shot: process.env.CUTOUT_SHOT || '',
  exportPath: process.env.CUTOUT_EXPORT || '',
  exportSeconds: Number(process.env.CUTOUT_EXPORT_SECONDS || 0),
  exportCodec: process.env.CUTOUT_EXPORT_CODEC || 'h264',
  exportTransparent: process.env.CUTOUT_EXPORT_TRANSPARENT === '1',
  fresh: !!process.env.CUTOUT_USER_DATA
}))

ipcMain.handle('shot', (_e, path: string) => captureAndQuit(path))
ipcMain.handle('quit', () => app.quit())

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  matteProc?.kill()
  app.quit()
})

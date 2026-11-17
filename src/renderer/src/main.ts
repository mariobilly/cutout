import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/archivo-black/400.css'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import './style.css'
import { Pane } from 'tweakpane'
import type { FolderApi } from '@tweakpane/core'
import { Vision, type Face, type MaskData } from './vision/Vision'
import { Source, MatteTrack, loadLibrary, loadShapeImage } from './source'
import { Pipeline, GLOBAL_DEFAULTS, type Global } from './core/pipeline'
import { STYLES, styleById, type StyleId, type UiHooks } from './styles'
import { outputSize, type Assets, type ShapeImage } from './core/frame'
import { randomize } from './core/random'
import type { RandRule } from './styles/types'
import type { Codec } from '../../preload'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const api = window.api

// ---------- persisted state ----------

type Params = Record<string, unknown>
interface UserPreset {
  name: string
  values: Params
}
interface Saved {
  style: StyleId
  global: Global
  params: Record<string, Params>
  user: Record<string, UserPreset[]>
}

const STORE = 'cutout.v1'
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))

function freshState(): Saved {
  return {
    style: 'tag',
    global: clone(GLOBAL_DEFAULTS),
    params: Object.fromEntries(STYLES.map((s) => [s.id, clone(s.defaults)])),
    user: {}
  }
}

function loadState(fresh: boolean): Saved {
  const st = freshState()
  if (fresh) return st
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null') as Partial<Saved> | null
    if (raw) {
      if (raw.style && STYLES.some((s) => s.id === raw.style)) st.style = raw.style
      Object.assign(st.global, raw.global ?? {})
      for (const s of STYLES) Object.assign(st.params[s.id], raw.params?.[s.id] ?? {})
      st.user = raw.user ?? {}
    }
  } catch {
    // corrupt settings: start clean
  }
  return st
}

let state: Saved = freshState()
let saveTimer = 0
function save(): void {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => localStorage.setItem(STORE, JSON.stringify(state)), 300)
}

const g = (): Global => state.global
const style = () => styleById(state.style)
const params = (): Params => state.params[state.style]
const needs = () => style().needs(params() as never)
/** The current look leaves transparent pixels (global toggle, or CUT with no background). */
const hasAlpha = (): boolean => g().transparent || !!style().alpha?.(params() as never)
/** CUT reads the HQ matte sharper: its edge is the alpha itself, not a traced outline. */
const maskRes = (): number => (state.style === 'cut' ? 1280 : 512)

// ---------- engine ----------

const view = $<HTMLCanvasElement>('view')
const vctx = view.getContext('2d')!
const source = new Source()
const matte = new MatteTrack()
const vision = new Vision()
const pipeline = new Pipeline()
const assets: Assets = { library: [], snapshots: [], shapeImages: [] }

let mask: MaskData | null = null
let faces: Face[] = []
let srcStamp = 0
let analyzedStamp = -1
let lastHold = -1
let dirty = true
let before = false
let exporting = false
let stillT = 0
let stillPlaying = false
let stillClock = 0
let snapshotsFor = ''
let modelsKey = ''

vision.onStatus = (s) => (s ? toast(s) : hideToast('model'))

function isPlaying(): boolean {
  return source.kind === 'video' ? !source.video.paused : stillPlaying
}

function currentTime(): number {
  if (source.kind === 'video') return source.video.currentTime
  if (stillPlaying) stillT = ((performance.now() - stillClock) / 1000) % source.duration
  return stillT
}

async function ensureModels(): Promise<void> {
  const n = needs()
  const need = { person: n.person && !(g().maskSource === 'hq' && matte.ready), face: n.face, model: g().liveModel }
  const key = JSON.stringify(need)
  if (key === modelsKey || (!need.person && !need.face)) return
  modelsKey = key
  await vision.ensure(need)
  analyzedStamp = -1
  dirty = true
}

let snapshotsP: Promise<void> = Promise.resolve()
function ensureSnapshots(): Promise<void> {
  if (!source.ready || snapshotsFor === source.url) return snapshotsP
  snapshotsFor = source.url
  toast('Pulling frames from across the clip…', 'snap')
  snapshotsP = source.snapshots(16).then((s) => {
    assets.snapshots = s
    hideToast('snap')
    dirty = true
  })
  return snapshotsP
}

function needsChanged(): void {
  void ensureModels()
  if (needs().snapshots) void ensureSnapshots()
}

/** Live analysis of the current source frame (fire and forget; latest frame wins). */
function analyzeLive(): void {
  const n = needs()
  const useHq = n.person && g().maskSource === 'hq' && matte.ready
  const need = { person: n.person && !useHq, face: n.face, model: g().liveModel }
  if ((!need.person && !need.face) || vision.busy || analyzedStamp === srcStamp) return
  const stamp = srcStamp
  analyzedStamp = stamp
  vision
    .analyze(source.frame, source.frame.width, source.frame.height, need, 0.5)
    .then((res) => {
      if (need.person && res.person) mask = res.person
      faces = res.faces
      dirty = true
    })
    .catch((e) => toast(String(e), 'err'))
}

function previewDims(): { W: number; H: number } {
  return outputSize(g().aspect, source.w, source.h, Math.round(1920 * g().previewScale))
}

function fitView(): void {
  const vw = $('viewer').clientWidth - 48
  const vh = $('viewer').clientHeight - 48
  const k = Math.min(vw / view.width, vh / view.height)
  view.style.width = `${Math.floor(view.width * k)}px`
  view.style.height = `${Math.floor(view.height * k)}px`
}

function draw(t: number): void {
  const { W, H } = previewDims()
  if (view.width !== W || view.height !== H) {
    view.width = W
    view.height = H
    fitView()
  }
  const n = needs()
  pipeline.render({
    ctx: vctx,
    W,
    H,
    t,
    duration: source.duration,
    src: source.frame,
    srcW: source.frame.width,
    srcH: source.frame.height,
    mask: n.person ? mask : null,
    faces: n.face ? faces : [],
    style: style(),
    params: params(),
    global: g(),
    assets,
    before
  })
  view.classList.toggle('checker', hasAlpha())
}

function tick(): void {
  requestAnimationFrame(tick)
  if (!source.ready || exporting) return
  const playing = isPlaying()
  const t = currentTime()
  if (source.kind === 'video') {
    const hold = g().holdFps > 0 ? Math.floor(t * g().holdFps) : Math.round(t * 1000)
    if (hold !== lastHold) {
      lastHold = hold
      source.draw()
      srcStamp++
      dirty = true
    }
  }
  const n = needs()
  if (n.person && g().maskSource === 'hq' && matte.ready) {
    matte.follow(t, playing)
    const m = matte.read(maskRes())
    if (m && (playing || dirty || !mask)) {
      mask = m
      dirty = true
    }
  }
  analyzeLive()
  if (playing || dirty) {
    dirty = false
    draw(t)
    updateTransport(t)
  }
}

// ---------- UI: toast ----------

let toastOwner = ''
function toast(text: string, owner = 'model', progress?: number): void {
  const el = $('toast')
  // A passing model-loading status must not wipe an error before it can be read (e.g. "HQ matte is not set up").
  if (owner === 'model' && toastOwner === 'err' && !el.hidden) return
  el.hidden = false
  el.classList.toggle('err', owner === 'err')
  $('toast-text').textContent = text
  toastOwner = owner
  const bar = $('toast-bar')
  bar.classList.toggle('on', progress !== undefined)
  if (progress !== undefined) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`
  if (owner === 'err' || owner === 'info') {
    window.setTimeout(() => {
      if (toastOwner === owner && $('toast-text').textContent === text) $('toast').hidden = true
    }, owner === 'err' ? 9000 : 3500)
  }
}
function hideToast(owner: string): void {
  if (toastOwner === owner) $('toast').hidden = true
}

// ---------- UI: tabs, presets, pane ----------

function buildTabs(): void {
  const nav = $('tabs')
  nav.innerHTML = ''
  STYLES.forEach((s, i) => {
    const b = document.createElement('button')
    b.className = `tab${s.id === state.style ? ' on' : ''}`
    b.style.setProperty('--chip', s.chip)
    b.title = `${s.blurb} (${i + 1})`
    b.innerHTML = `<span class="chip"></span><span><b>${s.name} <kbd>${i + 1}</kbd></b><small>${s.blurb}</small></span>`
    b.onclick = () => setStyle(s.id)
    nav.appendChild(b)
  })
}

function setStyle(id: StyleId): void {
  state.style = id
  buildTabs()
  buildPane()
  buildPresets()
  needsChanged()
  pipeline.reset()
  syncAlpha()
  dirty = true
  save()
  if (id === 'cut') void autoMatteStill()
}

function buildPresets(): void {
  const sel = $<HTMLSelectElement>('preset')
  const st = style()
  const user = state.user[st.id] ?? []
  sel.innerHTML =
    `<option value="">${st.name} presets…</option>` +
    st.presets.map((p, i) => `<option value="b${i}">${p.name}</option>`).join('') +
    (user.length ? `<optgroup label="Saved">${user.map((p, i) => `<option value="u${i}">${p.name}</option>`).join('')}</optgroup>` : '')
  sel.value = ''
}

function applyPreset(values: Params): void {
  pushHistory()
  const p = params()
  Object.assign(p, clone(style().defaults), values)
  syncCaptions()
  pane?.refresh()
  syncAlpha()
  dirty = true
  save()
}

// ---------- randomize / vary / undo ----------

const LOOK_RAND: Record<string, RandRule> = {
  boilFps: { min: 4, max: 12, int: true },
  grain: { min: 0, max: 0.45 },
  paper: { pick: [0, 0, 0, 0.25, 0.5] }
}
const LOOK_KEYS = ['boilFps', 'grain', 'paper', 'seed'] as const
type Snapshot = { style: StyleId; params: Params; look: Params }
const history: Snapshot[] = []

function pushHistory(): void {
  history.push({
    style: state.style,
    params: clone(params()),
    look: Object.fromEntries(LOOK_KEYS.map((k) => [k, g()[k]]))
  })
  if (history.length > 60) history.shift()
  $<HTMLButtonElement>('undo').disabled = false
}

function undo(): void {
  const snap = history.pop()
  $<HTMLButtonElement>('undo').disabled = !history.length
  if (!snap) return
  if (snap.style !== state.style) {
    state.style = snap.style
    buildTabs()
    buildPane()
    buildPresets()
  }
  Object.assign(state.params[snap.style], snap.params)
  Object.assign(g(), snap.look)
  afterParamJump()
}

/** amount 1 = fresh random look; < 1 = a variation of what's on screen (e.g. on top of a preset). */
function roll(amount: number): void {
  pushHistory()
  const st = style()
  randomize(params(), st.random as Record<string, RandRule>, amount)
  st.fix?.(params() as never)
  randomize(g(), LOOK_RAND, amount)
  if (amount >= 1 || Math.random() < 0.5) g().seed = 1 + Math.floor(Math.random() * 998)
  afterParamJump()
  toast(amount >= 1 ? 'Randomized: R again, V to vary, Ctrl+Z to undo' : 'Varied: V again, Ctrl+Z to undo', 'info')
}

function afterParamJump(): void {
  syncCaptions()
  pane?.refresh()
  syncAlpha()
  needsChanged()
  pipeline.reset()
  dirty = true
  save()
}

$('rand').onclick = () => roll(1)
$('vary').onclick = () => roll(0.25)
$('undo').onclick = undo

// ---------- transparent background ----------

function syncAlpha(): void {
  const b = $('alpha')
  b.classList.toggle('on', g().transparent)
  b.title = g().transparent ? 'Transparent background: ON (T)' : 'Transparent background: off (T)'
  view.classList.toggle('checker', hasAlpha())
}
$('alpha').onclick = () => {
  g().transparent = !g().transparent
  syncAlpha()
  pane?.refresh()
  dirty = true
  save()
}

$<HTMLSelectElement>('preset').onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value
  if (!v) return
  const st = style()
  const values = v[0] === 'b' ? (st.presets[Number(v.slice(1))]?.values as Params) : state.user[st.id]?.[Number(v.slice(1))]?.values
  if (values) applyPreset(values)
}
$('preset-save').onclick = () => {
  $('save-row').hidden = !$('save-row').hidden
  $<HTMLInputElement>('preset-name').focus()
}
$('preset-ok').onclick = () => {
  const name = $<HTMLInputElement>('preset-name').value.trim()
  if (!name) return
  const list = (state.user[state.style] ??= [])
  list.push({ name, values: clone(params()) })
  $<HTMLInputElement>('preset-name').value = ''
  $('save-row').hidden = true
  buildPresets()
  save()
  toast(`Saved preset “${name}”`, 'info')
}
$<HTMLInputElement>('preset-name').onkeydown = (e) => {
  if (e.key === 'Enter') $('preset-ok').click()
}
$('reset').onclick = () => applyPreset({})

function syncCaptions(): void {
  const box = $('captions-box')
  box.hidden = state.style !== 'sticker'
  $<HTMLTextAreaElement>('captions').value = String(state.params.sticker.captions ?? '')
}
$<HTMLTextAreaElement>('captions').oninput = (e) => {
  state.params.sticker.captions = (e.target as HTMLTextAreaElement).value
  dirty = true
  save()
}

const hooks: UiHooks = {
  async chooseLibrary() {
    const dir = await api.chooseFolder('Folder of fill pictures (images or videos)')
    if (!dir) return
    await loadLibraryDir(dir)
  },
  clearLibrary() {
    assets.library = []
    localStorage.removeItem('cutout.libraryDir')
    toast('Fill pictures: frames from your video', 'info')
    dirty = true
  },
  async chooseShapes() {
    const files = await api.chooseFiles('Shape image(s): a chair, a hand, a logo… (PNG with transparency is best)', 'image', true)
    if (!files.length) return
    await loadShapes(files)
  },
  clearShapes() {
    assets.shapeImages = []
    dirty = true
  },
  info: () => ({ library: assets.library.length, shapes: assets.shapeImages.length, snapshots: assets.snapshots.length }),
  makeHq: () => void makeHq(),
  get global() {
    return g()
  }
}

async function loadLibraryDir(dir: string): Promise<void> {
  const paths = await api.folderMedia(dir)
  if (!paths.length) return toast('No images or videos in that folder', 'err')
  assets.library = await loadLibrary(paths, (d, t) => toast(`Loading fill pictures ${d}/${t}`, 'lib', d / t))
  hideToast('lib')
  localStorage.setItem('cutout.libraryDir', dir)
  toast(`${assets.library.length} fill pictures loaded`, 'info')
  dirty = true
}

async function loadShapes(files: string[]): Promise<void> {
  const out: ShapeImage[] = []
  for (let i = 0; i < files.length; i++) {
    toast(`Cutting out shape ${i + 1}/${files.length}…`, 'shape', i / files.length)
    try {
      const s = await loadShapeImage(files[i], true)
      if (s) out.push(s)
    } catch (e) {
      toast(String(e), 'err')
    }
  }
  hideToast('shape')
  assets.shapeImages = out
  const p = state.params.fill
  p.shapeFrom = 'image'
  pane?.refresh()
  toast(out.length ? `${out.length} shape${out.length > 1 ? 's' : ''} ready` : 'Could not find a shape in those images', out.length ? 'info' : 'err')
  dirty = true
}

let pane: Pane | null = null

function buildPane(): void {
  pane?.dispose()
  pane = new Pane({ container: $('pane') })
  const st = style()
  const sf = pane.addFolder({ title: `${st.name} — look` }) as unknown as FolderApi
  st.controls(sf, params() as never, hooks)

  const G = g()
  const tf = pane.addFolder({ title: 'Time & frame' })
  tf.addBinding(G, 'boilFps', { label: 'boil fps', min: 1, max: 30, step: 1 })
  tf.addBinding(G, 'holdFps', { label: 'stop-motion fps (0 off)', min: 0, max: 30, step: 1 })
  tf.addBinding(G, 'seed', { min: 1, max: 999, step: 1 })
  tf.addButton({ title: 'Shuffle seed' }).on('click', () => {
    G.seed = 1 + Math.floor(Math.random() * 998)
    pane?.refresh()
  })
  tf.addBinding(G, 'aspect', { label: 'frame', options: { source: 'source', '9:16 vertical': '9:16', '4:5 post': '4:5', '1:1': '1:1', '16:9': '16:9' } })
  tf.addBinding(G, 'fit', { options: { fill: 'cover', fit: 'contain' } })
  tf.addBinding(G, 'zoom', { min: 0.5, max: 3 })
  tf.addBinding(G, 'grain', { min: 0, max: 1 })
  tf.addBinding(G, 'paper', { label: 'paper texture', min: 0, max: 1 })

  const mf = pane.addFolder({ title: 'Cut-out mask', expanded: false })
  mf.addBinding(G, 'maskSource', { label: 'mask from', options: { 'live (MediaPipe)': 'live', 'HQ matte (GPU)': 'hq' } })
  mf.addBinding(G, 'liveModel', { label: 'live model', options: { selfie: 'selfie', 'multiclass (bodies)': 'multiclass' } })
  mf.addBinding(G, 'hqEngine', { label: 'HQ engine', options: { 'any subject': 'saliency', 'people only (YOLO)': 'people' } })
  mf.addButton({ title: 'Make HQ matte (GPU)' }).on('click', () => void makeHq())
  mf.addBinding(G, 'threshold', { min: 0.1, max: 0.9 })
  mf.addBinding(G, 'smoothing', { label: 'temporal smooth', min: 0, max: 0.9 })
  mf.addBinding(G, 'edgeBlur', { label: 'edge soften', min: 0, max: 4, step: 1 })
  mf.addBinding(G, 'minArea', { label: 'min size %', min: 0.05, max: 10 })
  mf.addBinding(G, 'previewScale', { label: 'preview quality', options: { draft: 0.35, half: 0.5, full: 1 } })

  pane.on('change', () => {
    dirty = true
    needsChanged()
    save()
    // Switching "main subject / people only" on a photo re-cuts it right away.
    if (state.style === 'cut') void autoMatteStill()
  })
  syncCaptions()
}

// ---------- HQ matte ----------

/** The optional HQ matte said it isn't installed: don't start it on our own again this session (the button still can). */
let hqMissing = false

async function makeHq(): Promise<void> {
  if (!source.ready || !source.path) return toast('HQ matte needs a video or image opened from disk.', 'err')
  const engine = g().hqEngine
  toast('Starting HQ matte (Python + GPU)…', 'hq', 0)
  try {
    const out = await api.matteRun(source.path, engine)
    await matte.load(out)
    matte.engine = engine
    g().maskSource = 'hq'
    pane?.refresh()
    hideToast('hq')
    toast(source.kind === 'image' ? 'Background removed (GPU matte)' : 'HQ matte ready', 'info')
    pipeline.reset()
    dirty = true
  } catch (e) {
    hideToast('hq')
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    if (msg.startsWith('HQ matte is not set up')) hqMissing = true
    toast(msg, 'err')
  }
}
api.onMatteProgress((d, t) => toast(t > 1 ? `HQ matte ${d}/${t} frames` : 'Removing background on the GPU…', 'hq', d / t))

/** Stills in CUT get the GPU matte automatically: that's the whole point of "remove background". */
async function autoMatteStill(): Promise<void> {
  if (source.kind !== 'image' || !source.path || state.style !== 'cut' || hqMissing) return
  if (matte.ready && matte.engine === g().hqEngine) return
  await makeHq()
}
api.onMatteStatus((s) => toast(s, 'hq', 0))

// ---------- source ----------

async function openSource(path: string, file?: File): Promise<void> {
  try {
    toast(`Loading ${path.split(/[\\/]/).pop() || file?.name}…`, 'load')
    source.video.pause()
    stillPlaying = false
    await source.load(path, file)
    matte.unload()
    mask = null
    faces = []
    snapshotsFor = ''
    assets.snapshots = []
    pipeline.reset()
    await vision.reset()
    analyzedStamp = -1
    srcStamp++
    lastHold = -1
    $('empty').classList.add('hide')
    view.classList.add('show')
    $('srcname').textContent = source.name
    $('srcname').title = source.path
    $('dur').textContent = fmt(source.duration)
    hideToast('load')
    if (source.path) {
      const cached = await api.matteCached(source.path, g().hqEngine)
      if (cached) {
        await matte.load(cached)
        matte.engine = g().hqEngine
        if (source.kind === 'image') g().maskSource = 'hq'
      }
    }
    await autoMatteStill()
    if (g().maskSource === 'hq' && !matte.ready) toast('No HQ matte for this clip yet: using the live mask. (Cut-out mask → Make HQ matte)', 'info')
    modelsKey = ''
    needsChanged()
    fitView()
    dirty = true
  } catch (e) {
    toast(`Could not open: ${(e as Error).message}`, 'err')
  }
}

async function openDialog(): Promise<void> {
  const [p] = await api.chooseFiles('Open a video or image', 'media')
  if (p) await openSource(p)
}

// ---------- transport ----------

const fmt = (s: number): string => {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

let scrubbing = false
function updateTransport(t: number): void {
  $('time').textContent = fmt(t)
  if (!scrubbing) $<HTMLInputElement>('scrub').value = String(Math.round((t / Math.max(0.001, source.duration)) * 1000))
  $('play').textContent = isPlaying() ? '❚❚' : '▶'
}

function togglePlay(): void {
  if (!source.ready) return
  if (source.kind === 'video') {
    if (source.video.paused) void source.video.play()
    else source.video.pause()
  } else {
    stillPlaying = !stillPlaying
    stillClock = performance.now() - stillT * 1000
  }
  dirty = true
}

async function seekTo(t: number): Promise<void> {
  if (source.kind === 'video') {
    await source.seek(t)
    srcStamp++
  } else stillT = t
  dirty = true
}

$('play').onclick = togglePlay
$<HTMLInputElement>('scrub').oninput = (e) => {
  scrubbing = true
  const t = (Number((e.target as HTMLInputElement).value) / 1000) * source.duration
  void seekTo(t)
}
$<HTMLInputElement>('scrub').onchange = () => (scrubbing = false)
$('mute').onclick = () => {
  source.video.muted = !source.video.muted
  $('mute').textContent = source.video.muted ? '🔇' : '🔊'
}
const setBefore = (on: boolean): void => {
  before = on
  $('before').classList.toggle('on', on)
  dirty = true
}
$('before').onmousedown = () => setBefore(true)
$('before').onmouseup = $('before').onmouseleave = () => setBefore(false)
$('open').onclick = () => void openDialog()
$('open2').onclick = () => void openDialog()
$('snap').onclick = () => void saveFramePng()

window.addEventListener('resize', fitView)
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'b' || e.key === 'B') setBefore(true)
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') void openDialog()
  else if (e.ctrlKey && e.key.toLowerCase() === 'e') openExport()
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') undo()
  else if (!e.ctrlKey && (e.key === 'r' || e.key === 'R')) roll(1)
  else if (!e.ctrlKey && (e.key === 'v' || e.key === 'V')) roll(0.25)
  else if (!e.ctrlKey && (e.key === 't' || e.key === 'T')) $('alpha').click()
  else if (/^[1-5]$/.test(e.key)) setStyle(STYLES[Number(e.key) - 1].id)
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (source.kind === 'video') {
      source.video.pause()
      void seekTo(Math.max(0, Math.min(source.duration, source.video.currentTime + (e.key === 'ArrowRight' ? 1 : -1) / source.fps)))
    }
  }
})
window.addEventListener('keyup', (e) => {
  if (e.key === 'b' || e.key === 'B') setBefore(false)
})

// drag & drop
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  $('dropzone').classList.add('on')
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('dropzone').classList.remove('on')
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('dropzone').classList.remove('on')
  const file = e.dataTransfer?.files[0]
  if (file) void openSource(api.pathForFile(file), file)
})

// ---------- analysis for exact (export / screenshot) frames ----------

async function analyzeExact(): Promise<{ mask: MaskData | null; faces: Face[] }> {
  const n = needs()
  const useHq = n.person && g().maskSource === 'hq' && matte.ready
  let m: MaskData | null = null
  let fc: Face[] = []
  if (useHq) m = matte.read(maskRes())
  const need = { person: n.person && !useHq, face: n.face, model: g().liveModel }
  if (need.person || need.face) {
    await vision.ensure(need)
    const res = await vision.analyze(source.frame, source.frame.width, source.frame.height, need, 0.5)
    if (need.person) m = res.person ?? null
    fc = res.faces
  }
  return { mask: m, faces: fc }
}

// ---------- PNG of the current frame ----------

async function saveFramePng(): Promise<void> {
  if (!source.ready) return
  // Stills at their own resolution (up to 4K) so a removed-background PNG keeps full detail.
  const long = source.kind === 'image' && g().aspect === 'source' ? Math.min(4096, Math.max(source.w, source.h)) : 1920
  const { W, H } = outputSize(g().aspect, source.w, source.h, long)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const t = currentTime()
  const pl = new Pipeline()
  pl.render({
    ctx: c.getContext('2d')!,
    W,
    H,
    t,
    duration: source.duration,
    src: source.frame,
    srcW: source.frame.width,
    srcH: source.frame.height,
    mask: needs().person ? mask : null,
    faces: needs().face ? faces : [],
    style: style(),
    params: params(),
    global: g(),
    assets
  })
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
  const out = await api.saveFile(`${source.name.replace(/\.\w+$/, '')}_${state.style}_${t.toFixed(2)}s.png`, [{ name: 'PNG', extensions: ['png'] }], await blob.arrayBuffer())
  if (out) toast(`Saved ${out}`, 'info')
}

// ---------- export ----------

interface ExportOpts {
  out: string
  codec: Codec
  long: number
  fps: number
  seconds: number
}

let cancelExport = false

async function runExport(o: ExportOpts, onProgress: (done: number, total: number, eta: number) => void): Promise<string> {
  exporting = true
  cancelExport = false
  const wasT = currentTime()
  source.video.pause()
  matte.video?.pause()
  const G: Global = { ...g() }
  const { W, H } = outputSize(G.aspect, source.w, source.h, o.long)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const dur = Math.min(source.duration, o.seconds > 0 ? o.seconds : source.duration)
  const total = Math.max(1, Math.round(dur * o.fps))
  const n = needs()
  if (n.snapshots) await ensureSnapshots()
  const pl = new Pipeline()
  await vision.reset()
  await api.renderStart({
    out: o.out,
    width: W,
    height: H,
    fps: o.fps,
    duration: dur,
    codec: o.codec,
    audioPath: source.kind === 'video' && source.hasAudio && source.path ? source.path : undefined
  })
  const t0 = performance.now()
  let lastTs = -1
  let m: MaskData | null = null
  let fc: Face[] = []
  try {
    for (let i = 0; i < total; i++) {
      if (cancelExport) throw new Error('Export cancelled')
      const t = i / o.fps
      const ts = G.holdFps > 0 ? Math.floor(t * G.holdFps) / G.holdFps : t
      if (ts !== lastTs) {
        await source.seek(ts)
        if (n.person && G.maskSource === 'hq' && matte.ready) await matte.seek(ts)
        ;({ mask: m, faces: fc } = await analyzeExact())
        lastTs = ts
      }
      pl.render({
        ctx,
        W,
        H,
        t,
        duration: source.duration,
        src: source.frame,
        srcW: source.frame.width,
        srcH: source.frame.height,
        mask: n.person ? m : null,
        faces: n.face ? fc : [],
        style: style(),
        params: params(),
        global: G,
        assets
      })
      const px = ctx.getImageData(0, 0, W, H).data
      await api.renderFrame(new Uint8Array(px.buffer, px.byteOffset, px.byteLength))
      const el = (performance.now() - t0) / 1000
      onProgress(i + 1, total, (el / (i + 1)) * (total - i - 1))
    }
    return await api.renderFinish()
  } catch (e) {
    await api.renderCancel()
    throw e
  } finally {
    exporting = false
    await vision.reset()
    await seekTo(wasT)
    analyzedStamp = -1
    dirty = true
  }
}

function openExport(): void {
  if (!source.ready) return toast('Open a video or image first', 'err')
  $('modal').hidden = false
  $('x-progress').hidden = true
  $<HTMLButtonElement>('x-go').disabled = false
  const fpsSel = $<HTMLSelectElement>('x-fps')
  fpsSel.options[0].textContent = `source (${Math.round(source.fps * 100) / 100})`
  // Transparent look + MP4 selected: offer the alpha-capable format instead.
  const codec = $<HTMLSelectElement>('x-codec')
  if (hasAlpha() && codec.value === 'h264') codec.value = 'prores4444'
  updateExportInfo()
}

function exportOpts(): Omit<ExportOpts, 'out'> {
  const fpsV = $<HTMLSelectElement>('x-fps').value
  const sec = Number($<HTMLInputElement>('x-seconds').value)
  return {
    codec: $<HTMLSelectElement>('x-codec').value as Codec,
    long: Number($<HTMLSelectElement>('x-long').value),
    fps: fpsV === 'source' ? source.fps : Number(fpsV),
    seconds: sec > 0 ? sec : source.kind === 'image' ? 5 : 0
  }
}

function updateExportInfo(): void {
  const o = exportOpts()
  const { W, H } = outputSize(g().aspect, source.w, source.h, o.long)
  const dur = Math.min(source.duration, o.seconds > 0 ? o.seconds : source.duration)
  const audio = source.hasAudio && o.codec !== 'png' ? ' · with audio' : ''
  $('x-info').textContent = `${W}×${H} · ${Math.round(dur * o.fps)} frames · ${style().name}${audio}`
  const alpha = $('x-alpha')
  if (hasAlpha() && o.codec === 'h264') {
    alpha.textContent = 'MP4 can’t hold transparency: transparent areas turn black. Pick ProRes 4444, WebM or PNG to keep it.'
    alpha.className = 'alpha-note warn'
  } else if (hasAlpha()) {
    alpha.textContent = 'Transparent background is kept (alpha channel).'
    alpha.className = 'alpha-note ok'
  } else {
    alpha.textContent = o.codec === 'h264' ? '' : 'Opaque frames: turn on Transparent BG (T) or use CUT → “nothing (transparent)” for alpha.'
    alpha.className = 'alpha-note'
  }
}
for (const id of ['x-codec', 'x-long', 'x-fps', 'x-seconds']) $(id).addEventListener('input', updateExportInfo)

$('x-cancel').onclick = () => {
  if (exporting) cancelExport = true
  else $('modal').hidden = true
}
$('x-go').onclick = async () => {
  const o = exportOpts()
  const out = await api.renderChoose(`${source.name.replace(/\.\w+$/, '')}_${state.style}`, o.codec)
  if (!out) return
  $<HTMLButtonElement>('x-go').disabled = true
  $('x-progress').hidden = false
  const bar = $('x-progress').querySelector('i') as HTMLElement
  try {
    const done = await runExport({ ...o, out }, (d, t, eta) => {
      bar.style.width = `${(d / t) * 100}%`
      $('x-status').textContent = `Frame ${d}/${t} · ${Math.ceil(eta)}s left`
    })
    $('modal').hidden = true
    toast(`Exported ${done}`, 'info')
    void api.reveal(done)
  } catch (e) {
    $('x-status').textContent = (e as Error).message.slice(0, 300)
    $<HTMLButtonElement>('x-go').disabled = false
  }
}
$('export').onclick = openExport

// ---------- boot ----------

async function boot(): Promise<void> {
  const auto = await api.autoload()
  state = loadState(auto.fresh)
  if (auto.style && STYLES.some((s) => s.id === auto.style)) state.style = auto.style as StyleId
  if (auto.preset) {
    const pr = style().presets.find((p) => p.name.toLowerCase() === auto.preset.toLowerCase())
    if (pr) Object.assign(params(), clone(style().defaults), pr.values)
  }
  for (let i = 0; i < auto.random; i++) roll(1)
  if (auto.random) console.log(`[cutout] random look: ${JSON.stringify(params())}`)
  if (auto.params) {
    const o = JSON.parse(auto.params) as { style?: Params; global?: Partial<Global> }
    Object.assign(params(), o.style ?? {})
    Object.assign(state.global, o.global ?? {})
  }
  buildTabs()
  buildPane()
  buildPresets()
  syncAlpha()
  await document.fonts.ready
  requestAnimationFrame(tick)

  const libDir = auto.fillDir || (!auto.fresh && localStorage.getItem('cutout.libraryDir'))
  if (libDir) await loadLibraryDir(libDir)
  if (auto.shapes) await loadShapes(auto.shapes.split('|'))
  if (!auto.load) {
    if (auto.shot) {
      await new Promise((r) => setTimeout(r, 600))
      await api.shot(auto.shot)
    }
    return
  }
  await openSource(auto.load)
  if (auto.hq) {
    state.global.hqEngine = auto.hq === 'people' ? 'people' : 'saliency'
    await makeHq()
  }
  if (auto.time) await seekTo(auto.time)
  if (auto.shot || auto.exportPath) {
    await ensureModels()
    if (needs().snapshots) await ensureSnapshots()
    // Warm the temporal state with a few frames before the target time so the shot isn't a cold start.
    if (source.kind === 'video') {
      for (const dt of [0.3, 0.2, 0.1, 0]) {
        await source.seek(Math.max(0, auto.time - dt))
        if (needs().person && g().maskSource === 'hq' && matte.ready) await matte.seek(Math.max(0, auto.time - dt))
        const r = await analyzeExact()
        mask = r.mask
        faces = r.faces
        if (r.mask) {
          let mx = 0
          let on = 0
          for (const v of r.mask.data) {
            if (v > mx) mx = v
            if (v > 127) on++
          }
          console.log(`[cutout] mask ${r.mask.w}x${r.mask.h} max=${mx} on=${((on / r.mask.data.length) * 100).toFixed(1)}% faces=${r.faces.length} devices=${JSON.stringify(vision.devices)}`)
        } else console.log(`[cutout] no mask, faces=${r.faces.length}, status=${vision.status}`)
        srcStamp++
        analyzedStamp = srcStamp
        draw(Math.max(0, auto.time - dt))
      }
    } else {
      const r = await analyzeExact()
      mask = r.mask
      faces = r.faces
      draw(auto.time)
    }
    lastHold = g().holdFps > 0 ? Math.floor(auto.time * g().holdFps) : Math.round(auto.time * 1000)
    dirty = false
    updateTransport(auto.time)
  }
  if (auto.exportPath) {
    if (auto.exportTransparent) g().transparent = true
    const fps = source.fps
    try {
      const out = await runExport(
        {
          out: auto.exportPath,
          codec: (['prores4444', 'webm', 'png'].includes(auto.exportCodec) ? auto.exportCodec : 'h264') as Codec,
          long: 1920,
          fps,
          seconds: auto.exportSeconds || (source.kind === 'image' ? 3 : 0)
        },
        (d, t) => toast(`export ${d}/${t}`, 'x', d / t)
      )
      console.log('[cutout] exported', out)
    } catch (e) {
      console.error('[cutout] export failed', e)
    }
    if (!auto.shot) return void api.quit()
  }
  if (auto.play) {
    ;(globalThis as { __cutoutDebug?: boolean }).__cutoutDebug = true
    // Live-loop test: play for a while, then capture whatever the preview shows.
    togglePlay()
    await new Promise((r) => setTimeout(r, auto.play * 1000))
    console.log(`[cutout] played to ${currentTime().toFixed(2)}s, preview ${view.width}x${view.height}, mask=${!!mask}, shapes=${pipeline.shapeCount}`)
  }
  if (auto.shot) {
    await new Promise((r) => setTimeout(r, 400))
    await api.shot(auto.shot)
  }
}

void boot()

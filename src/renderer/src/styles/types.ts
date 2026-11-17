import type { FolderApi } from '@tweakpane/core'
import type { Frame } from '../core/frame'

export type StyleId = 'tag' | 'sticker' | 'fill' | 'shred' | 'cut'

export interface StyleNeeds {
  person: boolean
  face: boolean
  /** Frames from across the source (time slip / fallback fills). */
  snapshots: boolean
}

/** App services a style's controls can call (file pickers, status). */
export interface UiHooks {
  chooseLibrary: () => void
  clearLibrary: () => void
  chooseShapes: () => void
  clearShapes: () => void
  info: () => { library: number; shapes: number; snapshots: number }
  /** Run the GPU matte (InSPyReNet / YOLO) for the open video or image. */
  makeHq: () => void
  /** App-wide settings object (for controls that live in a look but are global, e.g. the HQ engine). */
  global: Record<string, unknown>
}

/** How the randomizer may set one param: a numeric range, or a list to pick from (repeat entries to weight). */
export type RandRule = { min: number; max: number; int?: boolean } | { pick: readonly unknown[] }

export interface StyleDef<P extends object = Record<string, unknown>> {
  id: StyleId
  name: string
  /** One-line description under the tab. */
  blurb: string
  /** Tab chip color. */
  chip: string
  defaults: P
  presets: { name: string; values: Partial<P> }[]
  /** Curated ranges for Randomize / Vary (params not listed are left alone, e.g. caption text). */
  random: Partial<Record<keyof P, RandRule>>
  /** After randomizing: make dependent params agree (label color vs stroke, accent vs kept hue…). */
  fix?: (p: P) => void
  needs: (p: P) => StyleNeeds
  /** Hold the traced shapes for a whole boil step (stop-motion outline). */
  hold: (p: P) => boolean
  /** The look leaves transparent pixels (preview shows the checkerboard, export can keep alpha). */
  alpha?: (p: P) => boolean
  controls: (folder: FolderApi, p: P, hooks: UiHooks) => void
  render: (f: Frame, p: P) => void
}

export const BG_OPTIONS = { original: 'original', 'black & white': 'bw', blur: 'blur', paper: 'paper', solid: 'solid' }

/** Colors the randomizer draws from. */
export const SWATCH = {
  neon: ['#d4f23a', '#4fc3f7', '#ff4fd8', '#ff7a1a', '#9b6bff', '#00e0a4', '#ffe14a'],
  accent: ['#e8202a', '#e8202a', '#1f49ff', '#ff4fd8', '#ffc400', '#00a95c', '#ff6a00'],
  ground: ['#ffffff', '#f2ece0', '#e9e4d8', '#111111', '#1d3fbb', '#ff4fd8', '#d4f23a', '#2b2b2b', '#c9b79c'],
  ink: ['#0a0a0a', '#0a0a0a', '#0a0a0a', '#ffffff', '#1d3fbb']
}

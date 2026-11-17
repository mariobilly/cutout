import type { StyleDef, StyleId } from './types'
import { tag } from './tag'
import { sticker } from './sticker'
import { fill } from './fill'
import { shred } from './shred'
import { cut } from './cut'

export type { StyleDef, StyleId, UiHooks } from './types'

export const STYLES = [tag, sticker, fill, shred, cut] as unknown as StyleDef[]

export const styleById = (id: StyleId): StyleDef => STYLES.find((s) => s.id === id) ?? STYLES[0]

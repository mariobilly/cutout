/** A face as an ellipse in source-normalized coords (x right, y down, 0..1). Radii are fractions of width/height. */
export interface Face {
  cx: number
  cy: number
  rx: number
  ry: number
  angle: number
}

export type PersonModel = 'selfie' | 'multiclass'

/** Which models the active style needs. */
export interface Needs {
  face: boolean
  person: boolean
  model: PersonModel
}

/** Confidence mask (0..255), top-down rows, in the analyzed image's space. */
export interface MaskData {
  w: number
  h: number
  data: Uint8Array
}

export interface VisionResult {
  faces: Face[]
  person?: MaskData
}

export interface ModelUrls {
  loader: string
  wasm: string
  face: string
  selfie: string
  multiclass: string
}

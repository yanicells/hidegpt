export const FONT = 'Arial'

export const C = {
  chrome: '#ffffff',
  header: '#ffffff',
  gallery: '#f1f3f4',
  page: '#ffffff',
  surround: '#f8f9fa',
  text: '#202124',
  secondary: '#5f6368',
  muted: '#80868b',
  line: '#dadce0',
  menuLine: '#e8eaed',
  blue: '#1a73e8',
  blueHover: '#174ea6',
  chip: '#f1f3f4',
  chipActive: '#e8f0fe',
  danger: '#d93025',
  callout: '#f8f9fa',
  approval: '#fff8e1',
  search: '#f1f3f4',
  thumb: '#f8f9fa',
}

export const SHADOW = {
  offsetX: 0,
  offsetY: 1,
  blurRadius: 2,
  spreadRadius: 0,
  color: '#3c404326',
}

export const SHADOW_HOVER = {
  offsetX: 0,
  offsetY: 1,
  blurRadius: 3,
  spreadRadius: 1,
  color: '#3c40434d',
}

export const TITLEBAR =
  typeof process !== 'undefined' && process.platform === 'darwin' ? 36 : 8

export const PAGE_WIDTH = 816
export const HOME_MAX = 1100
export const CARD_COLS = 4
export const THUMB_H = 156
export const CARD_ROW_H = 228
export const TEMPLATE_H = 280
export const CARD_W = 220

export const LIGHT = {
  appearance: 'light' as const,
  text: C.text,
  textMuted: C.secondary,
  textFaint: C.muted,
  bg: C.page,
  border: C.line,
  accent: C.blue,
  caret: C.blue,
}

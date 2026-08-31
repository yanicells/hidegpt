export const FONT = typeof window === 'undefined' ? 'Arial' : 'IBM Plex Sans'

export const C = {
  chrome: '#f9fbfd',
  page: '#ffffff',
  surround: '#f0f4f9',
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
  shadow: '#00000014',
}

export const TITLEBAR =
  typeof process !== 'undefined' && process.platform === 'darwin' ? 36 : 8

export const PAGE_WIDTH = 816

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

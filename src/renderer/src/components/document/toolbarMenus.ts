/**
 * Costume mappings for the toolbar dropdowns: each real setting is shown as
 * the Docs control it sits in. Models are paragraph styles, reasoning
 * efforts are fonts, service tiers are font sizes, modes are editing modes.
 */

export const STYLE_SLOTS = [
  { name: 'Normal text', className: 'style-normal' },
  { name: 'Title', className: 'style-title' },
  { name: 'Subtitle', className: 'style-subtitle' },
  { name: 'Heading 1', className: 'style-h1' },
  { name: 'Heading 2', className: 'style-h2' },
  { name: 'Heading 3', className: 'style-h3' },
] as const

/** The style name standing in for the model at `index` in the provider's list. */
export function styleName(index: number): string {
  return STYLE_SLOTS[index]?.name ?? 'Normal text'
}

const EFFORT_FONTS: Record<string, string> = {
  none: 'Courier New',
  minimal: 'Verdana',
  low: 'Trebuchet MS',
  medium: 'Arial',
  high: 'Georgia',
  xhigh: 'Times New Roman',
  max: 'Impact',
}

const SPARE_FONTS = ['Comic Sans MS', 'Tahoma', 'Helvetica']

/** Font names for each effort, alphabetized like Docs' font list. */
export function effortFonts(efforts: string[]): { effort: string; font: string }[] {
  let spare = 0
  return efforts
    .map((effort) => ({ effort, font: EFFORT_FONTS[effort] ?? SPARE_FONTS[spare++ % SPARE_FONTS.length] }))
    .sort((a, b) => a.font.localeCompare(b.font))
}

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96]

/** 11 is the default tier; each further tier takes the next size up. */
export function tierForSize(size: number, tiers: string[]): string | null {
  if (size <= 11 || tiers.length === 0) return null
  const index = FONT_SIZES.indexOf(size) - FONT_SIZES.indexOf(12)
  return tiers[Math.min(index, tiers.length - 1)] ?? null
}

export function sizeForTier(tier: string | null | undefined, tiers: string[]): number {
  const index = tier ? tiers.indexOf(tier) : -1
  return index < 0 ? 11 : FONT_SIZES[FONT_SIZES.indexOf(12) + index]
}

export const EDIT_MODES = [
  { label: 'Editing', icon: 'edit', description: 'Edit document directly' },
  { label: 'Suggesting', icon: 'rate_review', description: 'Edits become suggestions' },
  { label: 'Viewing', icon: 'visibility', description: 'Read or print final document' },
] as const

export const ZOOMS = [50, 75, 90, 100, 125, 150, 200]

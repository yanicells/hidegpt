/** "high" → "High": a lower-case label as a heading-case word. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

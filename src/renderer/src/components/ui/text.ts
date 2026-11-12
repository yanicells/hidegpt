/** "high" → "High": a lower-case label as a heading-case word. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** The first name Docs greets an account by: "yan@school.edu" → "Yan", anything else → "Me". */
export function personName(accountLabel: string): string {
  return accountLabel.includes('@') ? capitalize(accountLabel.split('@')[0]) : 'Me'
}

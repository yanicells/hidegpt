/** Joins class names, skipping falsy parts. A tiny stand-in for clsx. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Base UI also accepts a className function; the ui wrappers take plain strings. */
export type Styled<P> = Omit<P, 'className'> & { className?: string }

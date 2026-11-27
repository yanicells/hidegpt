import type { Plugin } from 'vite'

/** A fontsource `.woff` fallback after the `.woff2` source: `, url(./files/x.woff) format('woff')`. */
const WOFF_SOURCE = /,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g

/** Removes the `.woff` fallbacks from fontsource CSS, keeping each face's `.woff2` source. */
export function dropWoffSources(css: string): string {
  return css.replace(WOFF_SOURCE, '')
}

/**
 * Vite plugin for the renderer: Chromium always takes the `.woff2`, so the `.woff`
 * files fontsource lists after it are never fetched. Dropping them from the CSS
 * before Vite resolves its `url()`s keeps them out of the build. Variable
 * packages (`@fontsource-variable/*`, like the Inter T3 Code loads) ship
 * `.woff2` only and pass through unchanged.
 */
export function woff2Only(): Plugin {
  return {
    name: 'hidegpt:woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].+\.css$/.test(id)) return null
      return { code: dropWoffSources(code), map: null }
    },
  }
}

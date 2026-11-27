/*
 * The font menu's faces (fontsource, SIL OFL 1.1). The menu draws each Docs
 * font name in its own face; nothing else uses these, so they stay out of the
 * launch CSS and main.tsx adds them after the first frame. Latin, regular
 * weight only. Carlito and Caladea are the metric-compatible stand-ins for
 * Calibri and Cambria (see `fontStack`).
 */
import amaticSc from '@fontsource/amatic-sc/files/amatic-sc-latin-400-normal.woff2?url'
import caladea from '@fontsource/caladea/files/caladea-latin-400-normal.woff2?url'
import carlito from '@fontsource/carlito/files/carlito-latin-400-normal.woff2?url'
import caveat from '@fontsource/caveat/files/caveat-latin-400-normal.woff2?url'
import comfortaa from '@fontsource/comfortaa/files/comfortaa-latin-400-normal.woff2?url'
import ebGaramond from '@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff2?url'
import lexend from '@fontsource/lexend/files/lexend-latin-400-normal.woff2?url'
import lobster from '@fontsource/lobster/files/lobster-latin-400-normal.woff2?url'
import lora from '@fontsource/lora/files/lora-latin-400-normal.woff2?url'
import merriweather from '@fontsource/merriweather/files/merriweather-latin-400-normal.woff2?url'
import montserrat from '@fontsource/montserrat/files/montserrat-latin-400-normal.woff2?url'
import nunito from '@fontsource/nunito/files/nunito-latin-400-normal.woff2?url'
import openSans from '@fontsource/open-sans/files/open-sans-latin-400-normal.woff2?url'
import oswald from '@fontsource/oswald/files/oswald-latin-400-normal.woff2?url'
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff2?url'
import playfairDisplay from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?url'
import robotoMono from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff2?url'
import spectral from '@fontsource/spectral/files/spectral-latin-400-normal.woff2?url'

const FONT_MENU_FACES: ReadonlyArray<readonly [family: string, url: string]> = [
  ['Amatic SC', amaticSc],
  ['Caladea', caladea],
  ['Carlito', carlito],
  ['Caveat', caveat],
  ['Comfortaa', comfortaa],
  ['EB Garamond', ebGaramond],
  ['Lexend', lexend],
  ['Lobster', lobster],
  ['Lora', lora],
  ['Merriweather', merriweather],
  ['Montserrat', montserrat],
  ['Nunito', nunito],
  ['Open Sans', openSans],
  ['Oswald', oswald],
  ['Pacifico', pacifico],
  ['Playfair Display', playfairDisplay],
  ['Roboto Mono', robotoMono],
  ['Spectral', spectral],
]

/**
 * Registers the faces, as fontsource's `latin-400.css` would. Like an
 * `@font-face` rule, a face is fetched only when a menu row first draws with it.
 */
export function addFontMenuFaces(): void {
  for (const [family, url] of FONT_MENU_FACES) {
    document.fonts.add(new FontFace(family, `url("${url}") format('woff2')`, { weight: '400', display: 'swap' }))
  }
}

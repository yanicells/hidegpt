import { app } from 'electron'

import { pinClock } from './clock'

/**
 * `HIDEGPT_HIDDEN=1`: boot setup for a fidelity capture (`pnpm fidelity:shots`),
 * imported by `src/main/index.ts` only when the variable is set. The window is
 * never shown (`window.ts`) and the app has no Dock icon, so a capture never
 * takes focus from whoever is using the Mac. Time zone and clock are pinned so
 * two runs on one commit produce identical pixels.
 */
if (process.env.HIDEGPT_FAKE !== '1' || !process.env.HIDEGPT_SCREENSHOT || !process.env.HIDEGPT_PHASE) {
  console.error(
    'HIDEGPT_HIDDEN needs HIDEGPT_FAKE=1, HIDEGPT_SCREENSHOT=<dir> and HIDEGPT_PHASE (core, states or motion).',
  )
  process.exit(1)
}

app.dock?.hide()
// A window that is never shown counts as hidden, and Chromium would throttle its timers and frames.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// GPU raster antialiases icons slightly differently from run to run; CPU raster is repeatable.
app.commandLine.appendSwitch('disable-gpu-rasterization')
process.env.TZ = 'UTC'
pinClock()

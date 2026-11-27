import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

// Without sRGB (see below), captures come out in the display's profile and match no
// target. Checked before ready and before the PID file, as T3 Code's
// DesktopPreReadyPlatform.ts reads and checks a switch's value.
if (app.commandLine.getSwitchValue('force-color-profile') !== 'srgb') {
  console.error(
    'HIDEGPT_HIDDEN needs --force-color-profile=srgb on the Electron command line; use pnpm fidelity:shots.',
  )
  process.exit(1)
}
// pnpm fidelity:shots kills a run that hangs, or is interrupted, by this PID.
const shots = process.env.HIDEGPT_SCREENSHOT
mkdirSync(shots, { recursive: true })
writeFileSync(join(shots, 'electron.pid'), String(process.pid))
app.dock?.hide()
// A window that is never shown counts as hidden, and Chromium would throttle its timers and frames.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// GPU raster antialiases icons slightly differently from run to run; CPU raster is repeatable.
app.commandLine.appendSwitch('disable-gpu-rasterization')
// Colours are drawn in sRGB, so a captured pixel is its CSS value on any display, by
// `--force-color-profile=srgb` on the launch command (scripts/fidelity/shots.ts). It can't
// be appended here: Chromium has already read the display's colour space by now, and
// captures then flip between sRGB and the display profile partway through a run.
process.env.TZ = 'UTC'
pinClock()

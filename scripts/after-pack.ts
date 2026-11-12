import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AfterPackContext } from 'electron-builder'

const setBundleName = (plist: string, name: string): void => {
  execFileSync('plutil', ['-replace', 'CFBundleName', '-string', name, plist])
}

/**
 * Names each helper app after itself. electron-builder renames Electron's
 * helpers ("Docs Helper (GPU).app") and their executables and display names,
 * but leaves `CFBundleName` as "Electron Helper (GPU)".
 */
export function nameHelpers(app: string, setName: (plist: string, name: string) => void = setBundleName): void {
  const frameworks = join(app, 'Contents', 'Frameworks')
  for (const entry of readdirSync(frameworks)) {
    if (entry.endsWith('.app')) setName(join(frameworks, entry, 'Contents', 'Info.plist'), entry.slice(0, -'.app'.length))
  }
}

/** electron-builder's `afterPack` hook: it runs before signing, so the edits are sealed in. */
export async function afterPack(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== 'darwin') return
  nameHelpers(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`))
}

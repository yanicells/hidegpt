import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { launch } from '@gpuix/react/automation'

const out = process.argv[2] ?? 'screenshots/docs.png'
mkdirSync(path.dirname(out), { recursive: true })

const app = await launch({
  command: 'bun',
  args: ['app.tsx'],
  env: { GPUIX_BACKGROUND: '1' },
})
await app.getByTestId('app').waitFor({ timeoutMs: 60_000 })
await app.getByTestId('new-doc').waitFor({ timeoutMs: 60_000 })
await app.clock.pause()
await app.screenshot({ path: out })
await app.close()

console.log(`[screenshot] wrote ${out}`)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { releaseLock, takeLock, waitForLock } from './lock.mjs'

let directory = null
const lockIn = () => join((directory = mkdtempSync(join(tmpdir(), 'bench-lock-'))), 'bench.lock')
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('refuses while a live bench holds the lock, and releases only its own', () => {
  const file = lockIn()
  takeLock(file)
  expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
  expect(() => takeLock(file)).toThrow(`another bench is running (pid ${process.pid}`)
  releaseLock(file)
  expect(existsSync(file)).toBe(false)
})

it("takes over a dead bench's lock and leaves nothing beside it", () => {
  const file = lockIn()
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(file, dead)
  takeLock(file)
  expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
  expect(readdirSync(directory)).toEqual(['bench.lock'])
})

it('waits while a live bench holds the lock, then takes it', async () => {
  const file = lockIn()
  takeLock(file)
  const waits = []
  const taking = waitForLock(file, { pollMs: 10, onWait: (why) => waits.push(why) })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(waits).toEqual([expect.stringContaining('another bench is running')])
  releaseLock(file)
  await taking
  expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
})

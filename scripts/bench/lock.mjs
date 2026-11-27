// One bench at a time on a machine: two would measure each other. The lock is a file that
// holds the pid of the bench using it. It only ever appears whole (written aside, then
// linked into place), so no reader sees it empty, and a dead bench's lock is moved aside
// by a rename that only one taker can win.
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const readPid = (file) => {
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** The error `takeLock` throws while a live bench holds the lock. */
const busy = (pid, file) =>
  Object.assign(new Error(`another bench is running (pid ${pid}, ${file}); wait for it to finish`), { code: 'EBUSY' })

const alive = (pid) => {
  try {
    return Number.isInteger(pid) && pid > 0 && process.kill(pid, 0)
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Puts this process's lock in place; false when a lock is already there. */
function create(file) {
  const draft = `${file}.${process.pid}.tmp`
  writeFileSync(draft, String(process.pid))
  try {
    linkSync(draft, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(draft, { force: true })
  }
}

/** Takes `file` for this process, or throws when a live bench holds it. */
export function takeLock(file) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (create(file)) return
    const holder = readPid(file)
    if (holder === null) continue
    if (alive(holder)) throw busy(holder, file)
    const aside = `${file}.${process.pid}.stale`
    try {
      renameSync(file, aside)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const moved = readPid(aside)
    if (moved !== holder) {
      // Another bench replaced the dead lock first: put its lock back and stop.
      try {
        linkSync(aside, file)
      } catch {}
      rmSync(aside, { force: true })
      throw busy(moved, file)
    }
    rmSync(aside, { force: true })
  }
  throw new Error(`could not take the bench lock ${file}`)
}

/** Takes `file` like `takeLock`, but while another bench holds it, waits for it in turn. */
export async function waitForLock(file, { pollMs = 5000, onWait = () => {} } = {}) {
  for (let waited = false; ; waited = true) {
    try {
      return takeLock(file)
    } catch (error) {
      if (error.code !== 'EBUSY') throw error
      if (!waited) onWait(error.message)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** Removes `file` if this process holds it. */
export function releaseLock(file) {
  if (readPid(file) === process.pid) rmSync(file, { force: true })
}

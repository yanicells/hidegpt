// Keeps the perf bench away from real providers: in the process it is installed in, every
// program the app starts is either the bench's fake Codex server or refused. hook.cjs
// installs it in the app's main process; the test runs it in a plain Node subprocess.
const { syncBuiltinESMExports } = require('node:module')
const path = require('node:path')

const METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']

/** Whether `command` starts Codex: anything named `codex`, or the fake itself. */
function isCodex(command, fake) {
  return path.basename(String(command)) === 'codex' || command === fake
}

/**
 * Patches `childProcess` (and its ESM named exports) so a Codex command runs `fake` and
 * any other command fails with ENOENT, as on a machine without that program. Refused
 * commands are appended to `blocked`, which is returned.
 */
function installSpawnGuard(childProcess, fake, blocked = []) {
  for (const name of METHODS) {
    const original = childProcess[name]
    childProcess[name] = function (command, ...rest) {
      if (isCodex(command, fake)) return original.call(this, fake, ...rest)
      blocked.push(String(command))
      return original.call(this, path.join('/nonexistent', `bench-blocked-${path.basename(String(command))}`), ...rest)
    }
  }
  syncBuiltinESMExports()
  return blocked
}

module.exports = { installSpawnGuard, isCodex }

#!/usr/bin/env node
// Reads a V8 .cpuprofile and says where the time went in terms of the source tree:
// self time per package or source file, and the hottest functions as file:line.
// Bundled positions are mapped back through the build's source maps
// (`electron-vite build --sourcemap`, which `run.mjs --build` does).
//
//   node scripts/bench/profile.mjs <file.cpuprofile> [repo]
import { existsSync, readFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Finds the built file a profile URL refers to (`docs://app/assets/x.js`, `file:///…/out/main/x.js`). */
function builtFile(url, repo) {
  if (url.startsWith('file://')) return fileURLToPath(url)
  if (url.startsWith('docs://')) return join(repo, 'out', 'renderer', new URL(url).pathname)
  return null
}

/** `node_modules/.pnpm/a@1/node_modules/@scope/pkg/x.js` → `@scope/pkg`; app files → `src/...`. */
function owner(source) {
  const at = source.lastIndexOf('node_modules/')
  if (at >= 0) {
    const parts = source.slice(at + 'node_modules/'.length).split('/')
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  const src = source.indexOf('src/')
  return src >= 0 ? source.slice(src) : source.replace(/^(\.\.\/)+/, '')
}

export function summarizeProfile(file, repo, { top = 25 } = {}) {
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const maps = new Map()
  const mapFor = (url) => {
    if (!maps.has(url)) {
      const built = builtFile(url, repo)
      const mapFile = built && `${built}.map`
      maps.set(url, mapFile && existsSync(mapFile) ? new SourceMap(JSON.parse(readFileSync(mapFile, 'utf8'))) : null)
    }
    return maps.get(url)
  }

  const self = new Map()
  profile.samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000))
  const total = [...self.values()].reduce((a, b) => a + b, 0)

  const byOwner = new Map()
  const byFunction = new Map()
  const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms)
  for (const node of profile.nodes) {
    const ms = self.get(node.id)
    if (!ms) continue
    const { functionName, url, lineNumber, columnNumber } = node.callFrame
    if (!url) {
      // (program) is native work between JS: style, layout, paint, IPC. (idle) is not work.
      add(byOwner, functionName || '(native)', ms)
      continue
    }
    const entry = mapFor(url)?.findEntry(lineNumber, columnNumber)
    if (entry?.originalSource) {
      const where = owner(entry.originalSource)
      add(byOwner, where, ms)
      add(byFunction, `${where}:${entry.originalLine + 1} ${entry.name ?? functionName ?? ''}`.trim(), ms)
    } else {
      const where = url.startsWith('node:') ? url : basename(url)
      add(byOwner, where, ms)
      add(byFunction, `${where}:${lineNumber + 1} ${functionName}`.trim(), ms)
    }
  }

  const idle = byOwner.get('(idle)') ?? 0
  byOwner.delete('(idle)')
  const busy = total - idle
  const table = (map, heading) =>
    [
      `| ${heading} | self ms | % of busy |`,
      '| --- | ---: | ---: |',
      ...[...map]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([name, ms]) => `| ${name} | ${ms.toFixed(0)} | ${((ms / busy) * 100).toFixed(1)}% |`),
    ].join('\n')
  return [
    `Sampled ${total.toFixed(0)} ms: ${busy.toFixed(0)} ms busy, ${idle.toFixed(0)} ms idle.`,
    '',
    table(byOwner, 'package or file'),
    '',
    table(byFunction, 'function (source file:line)'),
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, repo = process.cwd()] = process.argv.slice(2)
  if (!file) throw new Error('usage: profile.mjs <file.cpuprofile> [repo]')
  console.log(summarizeProfile(resolve(file), resolve(repo)))
}

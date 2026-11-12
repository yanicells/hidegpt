import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listPackage } from '@electron/asar'
import { parse, tokTypes, type Token } from 'acorn'

import { stealthViolations, VENDOR_WORDS, vendorViolations } from '../src/shared/stealth.ts'

/**
 * Stealth scans of what ships, so no banned word lands in the app unnoticed.
 *
 * - `pnpm stealth:scan` (after `pnpm build`, and in CI) reads every string the
 *   built renderer and preload carry. A string that looks like prose must pass
 *   the banned list; every string must pass the vendor list unless
 *   `stealth-allow.json` names it, with a reason and a count. The counts only
 *   go down: a literal seen more often than allowed fails, and so does one
 *   seen less often, until its count is lowered.
 * - `pnpm dist` ends with `assertStealthyApps`: no file path in `Docs.app`, no
 *   path inside its `app.asar` and no `Info.plist` string may name a vendor.
 */

export type Part = 'renderer' | 'preload'

export type AllowedLiteral = {
  readonly part: Part
  readonly literal: string
  readonly count: number
  readonly reason: string
}
export type AllowedPath = { readonly path: string; readonly reason: string }
export type AllowList = {
  readonly bundle: ReadonlyArray<AllowedLiteral>
  readonly packaged: ReadonlyArray<AllowedPath>
}

export type BundleFile = { readonly part: Part; readonly name: string; readonly source: string }
export type Hit = { readonly part: Part; readonly literal: string; readonly words: ReadonlyArray<string> }

const ALLOW_FILE = new URL('./stealth-allow.json', import.meta.url)

/**
 * Every string and template literal in a script. Acorn parses the whole file,
 * because only a parser can tell a regex from a division and so find where
 * each string really starts.
 */
function scriptStrings(source: string, sourceType: 'module' | 'script'): string[] {
  const strings: string[] = []
  const onToken = (token: Token) => {
    // acorn's Token type leaves out `value`, which string and template tokens carry.
    const value: unknown = 'value' in token ? token.value : undefined
    if ((token.type === tokTypes.string || token.type === tokTypes.template) && typeof value === 'string') {
      strings.push(value)
    }
  }
  parse(source, { ecmaVersion: 'latest', sourceType, onToken })
  return strings
}

/** Quoted strings in CSS (`content: "…"`, font names). */
const cssStrings = (source: string): string[] =>
  Array.from(source.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g), (match) => match[1] ?? match[2] ?? '')

/** Text between tags and attribute values in HTML. */
const htmlStrings = (source: string): string[] => [
  ...Array.from(source.matchAll(/>([^<]+)</g), (match) => match[1]!.trim()),
  ...Array.from(source.matchAll(/=\s*"([^"]*)"/g), (match) => match[1]!),
]

/** The strings in one built file, by its type. */
export function fileStrings(file: BundleFile): string[] {
  if (file.name.endsWith('.css')) return cssStrings(file.source)
  if (file.name.endsWith('.html')) return htmlStrings(file.source)
  return scriptStrings(file.source, file.name.endsWith('.cjs') ? 'script' : 'module')
}

/** A space, or a capital first letter: text a person might read, not an identifier. */
const looksLikeProse = (text: string) => /\s/.test(text.trim()) || /^[A-Z]/.test(text)

/**
 * A vendor name standing on its own in a code string: between characters
 * that are not letters or digits, so `"codex"` and `"window.hidegpt"` match
 * but an identifier such as `"CodexAdapter"` does not. Only this rule is that
 * loose; prose, file paths and plist strings go through the shared gate, which
 * splits words at case changes and digits.
 */
const VENDOR_IN_CODE = new RegExp(`(?<![a-z0-9])(?:${VENDOR_WORDS.join('|')})s?(?![a-z0-9])`, 'gi')

const vendorsInCode = (literal: string): string[] => Array.from(literal.matchAll(VENDOR_IN_CODE), ([word]) => word)

/** The strings that break a rule: any vendor word, or a banned word in prose. */
export function bundleHits(files: ReadonlyArray<BundleFile>): Hit[] {
  return files.flatMap((file) =>
    fileStrings(file).flatMap((literal) => {
      const vendor = vendorsInCode(literal)
      const words = vendor.length > 0 ? vendor : looksLikeProse(literal) ? stealthViolations(literal) : []
      return words.length > 0 ? [{ part: file.part, literal, words }] : []
    }),
  )
}

const preview = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text)

/** What is wrong with the hits against the allow-list; empty means the bundle passes. */
export function checkHits(hits: ReadonlyArray<Hit>, allowed: ReadonlyArray<AllowedLiteral>): string[] {
  const key = (part: Part, literal: string) => `${part}\u0000${literal}`
  const seen = new Map<string, { hit: Hit; count: number }>()
  for (const hit of hits) {
    const entry = seen.get(key(hit.part, hit.literal))
    if (entry) entry.count += 1
    else seen.set(key(hit.part, hit.literal), { hit, count: 1 })
  }
  const problems: string[] = []
  const entries = new Map(allowed.map((entry) => [key(entry.part, entry.literal), entry]))
  for (const [id, { hit, count }] of seen) {
    const entry = entries.get(id)
    if (!entry) problems.push(`${hit.part}: ${preview(hit.literal)} has ${hit.words.join(', ')} (${count}x)`)
    else if (count > entry.count)
      problems.push(`${hit.part}: ${preview(hit.literal)} appears ${count}x, allowed ${entry.count}x`)
  }
  for (const [id, entry] of entries) {
    const count = seen.get(id)?.count ?? 0
    if (count < entry.count) {
      problems.push(
        `${entry.part}: ${preview(entry.literal)} appears ${count}x; lower its count in stealth-allow.json to ${count}`,
      )
    }
  }
  return problems
}

export function readAllowList(): AllowList {
  return JSON.parse(readFileSync(ALLOW_FILE, 'utf8')) as AllowList
}

/** The built renderer (scripts, CSS, HTML) and preload under `out/`. */
export function builtFiles(outDir: string): BundleFile[] {
  const read = (part: Part, dir: string, pattern: RegExp) =>
    readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => ({ part, name, source: readFileSync(join(dir, name), 'utf8') }))
  return [
    ...read('renderer', join(outDir, 'renderer'), /\.html$/),
    ...read('renderer', join(outDir, 'renderer/assets'), /\.(js|css)$/),
    ...read('preload', join(outDir, 'preload'), /\.(c|m)?js$/),
  ]
}

// ---- the packaged app ----------------------------------------------------------------

/** Every path in `Docs.app` (relative to it), plus `app.asar:<path>` for each path in the archive. */
function appPaths(app: string): string[] {
  const paths = readdirSync(app, { recursive: true, encoding: 'utf8' })
  const archive = join(app, 'Contents/Resources/app.asar')
  const archived = listPackage(archive, { isPack: false }).map((path) => `app.asar:${path.replace(/^[/\\]/, '')}`)
  return [...paths, ...archived]
}

/** Every string value in a plist, read with `plutil` (macOS only, as is `pnpm dist`). */
function plistStrings(path: string): string[] {
  const json: unknown = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }))
  const strings: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(json)
  return strings
}

/** The allowed folder itself, or anything inside it. */
const under = (entry: AllowedPath, path: string) => path === entry.path || path.startsWith(`${entry.path}/`)

/**
 * Whether an allow-list entry covers a path: the entry itself, anything inside
 * it, or a folder on the way to it (`node_modules/@anthropic-ai` for an entry
 * naming one package in it). A sibling of the entry is not covered.
 */
const covers = (entry: AllowedPath, path: string) => under(entry, path) || entry.path.startsWith(`${path}/`)

/** File paths and plist strings in a packaged app that name a vendor, less what the allow-list covers. */
export function appLeaks(
  paths: ReadonlyArray<string>,
  plists: ReadonlyArray<string>,
  allowed: ReadonlyArray<AllowedPath>,
): string[] {
  const allowedPath = (path: string) => allowed.some((entry) => covers(entry, path))
  return [
    ...paths.filter((path) => vendorViolations(path).length > 0 && !allowedPath(path)),
    ...plists.filter((value) => vendorViolations(value).length > 0).map((value) => `Info.plist: ${preview(value)}`),
  ]
}

/** Every `.app` that `pnpm dist` wrote under `outputDir` (e.g. `dist/mac-arm64/Docs.app`). */
function packagedApps(outputDir: string): string[] {
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) =>
      readdirSync(join(outputDir, entry.name))
        .filter((name) => name.endsWith('.app'))
        .map((app) => join(outputDir, entry.name, app)),
    )
}

/** Throws if a packaged app under `outputDir` names a vendor in a path or a plist. */
export function assertStealthyApps(outputDir: string): void {
  const { packaged } = readAllowList()
  const apps = packagedApps(outputDir)
  if (apps.length === 0) throw new Error(`No packaged app found in ${outputDir}/ to scan`)
  for (const app of apps) {
    const paths = appPaths(app)
    const plists = paths.filter((path) => path.endsWith('Info.plist') && !path.startsWith('app.asar:'))
    const leaks = appLeaks(
      paths,
      plists.flatMap((path) => plistStrings(join(app, path))),
      packaged,
    )
    if (leaks.length > 0) throw new Error(`${relative('.', app)} names a vendor:\n  ${leaks.join('\n  ')}`)
    const unused = packaged.filter((entry) => !paths.some((path) => under(entry, path)))
    console.log(`Stealth scan: ${relative('.', app)} is clean (${paths.length} paths, ${plists.length} plists)`)
    for (const entry of unused) console.log(`  allow-list entry no longer needed here: ${entry.path}`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const started = performance.now()
  const files = builtFiles(new URL('../out', import.meta.url).pathname)
  const hits = bundleHits(files)
  const problems = checkHits(hits, readAllowList().bundle)
  const ms = Math.round(performance.now() - started)
  if (problems.length > 0) {
    console.error(`Stealth scan failed (${files.length} files, ${ms} ms):\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`Stealth scan: ${files.length} files clean in ${ms} ms (${hits.length} allowed occurrences)`)
}

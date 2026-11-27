// Adapted from T3 Code (apps/desktop/scripts/verify-preload-bundle.mjs) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { parse } from 'acorn'

import { HIDEGPT_API_METHODS } from '../src/shared/api.ts'

/**
 * Checks the built preload the way a sandboxed renderer will load it: it may
 * `require` only `electron`, with a literal name and no dynamic `import()`, and
 * running it must expose every `window.hidegpt` method. A preload that breaks
 * any of these opens a blank window, so `pnpm dist` runs this before packaging.
 *
 * Run alone with `node scripts/verify-preload-bundle.ts` after `pnpm build`.
 */

const EXECUTION_TIMEOUT_MS = 1_000

type SyntaxNode = { readonly type: string; readonly [key: string]: unknown }

const isSyntaxNode = (value: unknown): value is SyntaxNode =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

/** Every module the bundle `require`s, failing on dynamic loads. */
function runtimeImports(source: string): ReadonlyArray<string> {
  const imports: Array<string> = []
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'ImportExpression') throw new Error('The preload bundle contains a dynamic import() call')
    const callee = node.callee
    if (
      node.type === 'CallExpression' &&
      isSyntaxNode(callee) &&
      callee.type === 'Identifier' &&
      callee.name === 'require'
    ) {
      const args = node.arguments as ReadonlyArray<SyntaxNode>
      const [argument] = args
      if (args.length !== 1 || argument?.type !== 'Literal' || typeof argument.value !== 'string') {
        throw new Error('The preload bundle contains a dynamic require() call')
      }
      imports.push(argument.value)
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.filter(isSyntaxNode).forEach(visit)
      else if (isSyntaxNode(child)) visit(child)
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as SyntaxNode)
  return imports
}

/** Runs the bundle against a stub `electron` and returns what it exposed to the page. */
function execute(source: string): Map<string, unknown> {
  const exposed = new Map<string, unknown>()
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
    ipcRenderer: {
      invoke: () => Promise.resolve(undefined),
      on: () => undefined,
      off: () => undefined,
      removeListener: () => undefined,
      sendSync: () => null,
    },
  }
  const require = (name: string) => {
    if (name !== 'electron') throw new Error(`The preload asked for a module the sandbox lacks: ${name}`)
    return electron
  }
  runInNewContext(
    source,
    { require, process: { contextIsolated: true, platform: process.platform }, module: { exports: {} }, exports: {} },
    { filename: 'preload.cjs', timeout: EXECUTION_TIMEOUT_MS },
  )
  return exposed
}

/** Throws with the first problem found; returns quietly for a good bundle. */
export function verifyPreloadBundle(source: string): void {
  const unsupported = [...new Set(runtimeImports(source))].filter((name) => name !== 'electron').sort()
  if (unsupported.length > 0) {
    throw new Error(`The preload bundle requires modules a sandboxed preload can't load: ${unsupported.join(', ')}`)
  }
  const api = execute(source).get('hidegpt') as Record<string, unknown> | undefined
  if (!api) throw new Error('The preload bundle does not expose window.hidegpt')
  const missing = HIDEGPT_API_METHODS.filter((name) => typeof api[name] !== 'function')
  if (missing.length > 0) throw new Error(`The preload bundle is missing: ${missing.join(', ')}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyPreloadBundle(readFileSync(new URL('../out/preload/index.cjs', import.meta.url), 'utf8'))
  console.log('Preload bundle OK')
}

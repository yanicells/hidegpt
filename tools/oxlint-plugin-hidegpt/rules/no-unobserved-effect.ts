// Adapted from T3 Code (oxlint-plugin-t3code/rules/no-global-process-runtime.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

/**
 * Bans Effect forms whose failure nobody observes. In Effect 4 a Die skips
 * `tapError` and `ignore`, a forked fiber that dies logs nothing, and a bare
 * `Effect.run*` from a callback uses Effect's default console logger and
 * outlives every scope. Each form names its replacement in
 * src/provider/observed.ts. Where the bare form is right (a logger that
 * cannot log its own failure), disable the rule on that line with a reason.
 */

const FORKS = new Set(['fork', 'forkChild', 'forkIn', 'forkScoped', 'forkDetach', 'forkDaemon'])
const EFFECT_RUNS = new Set([
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseWith',
  'runPromiseExit',
  'runPromiseExitWith',
  'runSync',
  'runSyncWith',
  'runSyncExit',
  'runSyncExitWith',
  'runCallback',
  'runCallbackWith',
])
/** Fiber-starting runs on any object, such as `runtime.runFork(...)`. */
const ANY_RUNS = new Set(['runFork', 'runCallback'])

const forkMessage = (name: string) =>
  `Effect.${name}: fork through forkObserved or forkObservedIn (src/provider/observed.ts), so a defect is reported.`
const runMessage = (name: string) =>
  `${name}: start work from a callback through makeRunObserved (src/provider/observed.ts) or the IPC bridge; a bare run has no file logger and outlives every scope.`
const MESSAGES: Record<string, string> = {
  ignore:
    'Effect.ignore: a Die passes straight through it, unlogged. Use observed(effect, { name, quiet }) from src/provider/observed.ts.',
  ignoreCause:
    'Effect.ignoreCause: drops even a defect without a trace. Use observed(effect, { name, quiet }) from src/provider/observed.ts.',
  tapError:
    'Effect.tapError: a Die skips it. For a rollback use undoOnFailure (src/provider/observed.ts); to only log a typed error, disable this line with a reason.',
}

/** The message for `name` used from Effect (`Effect.name`, an alias, or a named import), if it is banned. */
const effectMessage = (name: string) =>
  FORKS.has(name)
    ? forkMessage(name)
    : EFFECT_RUNS.has(name)
      ? runMessage(`Effect.${name}`)
      : Object.hasOwn(MESSAGES, name)
        ? MESSAGES[name]
        : undefined

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Effect forks, runs, ignores and tapError that leave a defect unobserved.' },
  },
  create(context) {
    // As T3 Code's rule, the bindings come from this file's imports: `Effect` (always), and
    // `import * as E from 'effect/Effect'` or `import { Effect as Fx } from 'effect'` (namespaces),
    // `import * as effect from 'effect'` (roots, for `effect.Effect.fork`), and
    // `import { forkScoped as fork } from 'effect/Effect'` (local name to Effect's name).
    const namespaces = new Set(['Effect'])
    const roots = new Set<string>()
    const named = new Map<string, string>()

    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (source !== 'effect' && source !== 'effect/Effect') return
        for (const specifier of node.specifiers) {
          const local = specifier.local.name
          if (specifier.type !== 'ImportSpecifier') {
            if (source === 'effect') roots.add(local)
            else namespaces.add(local)
            continue
          }
          const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
          if (source === 'effect' && imported === 'Effect') namespaces.add(local)
          else if (source === 'effect/Effect') named.set(local, imported)
        }
      },
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return
        const name = node.property.name
        const object = node.object
        const onEffect =
          object.type === 'Identifier'
            ? namespaces.has(object.name)
            : object.type === 'MemberExpression' &&
              !object.computed &&
              object.object.type === 'Identifier' &&
              roots.has(object.object.name) &&
              object.property.type === 'Identifier' &&
              object.property.name === 'Effect'
        const message = onEffect ? effectMessage(name) : ANY_RUNS.has(name) ? runMessage(`.${name}`) : undefined
        if (message !== undefined) context.report({ node, message })
      },
      // A named import, called (`forkScoped(effect)`) or passed (`effect.pipe(forkScoped)`).
      CallExpression(node) {
        for (const used of [node.callee, ...node.arguments]) {
          const name = used.type === 'Identifier' ? named.get(used.name) : undefined
          const message = name === undefined ? undefined : effectMessage(name)
          if (message !== undefined) context.report({ node: used, message })
        }
      },
    }
  },
} satisfies Rule

export default rule

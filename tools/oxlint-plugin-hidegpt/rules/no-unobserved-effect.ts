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

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Effect forks, runs, ignores and tapError that leave a defect unobserved.' },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return
        const name = node.property.name
        const onEffect = node.object.type === 'Identifier' && node.object.name === 'Effect'
        if (onEffect && FORKS.has(name)) context.report({ node, message: forkMessage(name) })
        else if (onEffect && EFFECT_RUNS.has(name)) context.report({ node, message: runMessage(`Effect.${name}`) })
        else if (onEffect && name in MESSAGES) context.report({ node, message: MESSAGES[name]! })
        else if (!onEffect && ANY_RUNS.has(name)) context.report({ node, message: runMessage(`.${name}`) })
      },
    }
  },
} satisfies Rule

export default rule

import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import rule from './no-unobserved-effect.ts'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } } })
const header = "import * as Effect from 'effect/Effect'\n"

tester.run('hidegpt/no-unobserved-effect', rule, {
  valid: [
    // The observed helpers and awaited work.
    `${header}export const a = forkObserved({ name: 'x' })(Effect.void)`,
    `${header}export const b = observed(Effect.void, { name: 'x' }).pipe(Effect.catchCause(() => Effect.void))`,
    `${header}export const c = Effect.forEach([1], () => Effect.void, { concurrency: 'unbounded' })`,
    // A name shared with Effect but imported from elsewhere, or not imported at all.
    "import { ignore } from './lists'\nexport const e = ignore([1])",
    'export const e = (forkChild: () => void) => forkChild()',
    // Destructured, re-exported or read by a string key, but not banned.
    `${header}const { succeed } = Effect\nexport const s = succeed(1)`,
    "export { succeed } from 'effect/Effect'",
    `${header}export const s = Effect['succeed'](1)`,
    // A computed key that is not a string literal is not followed.
    `${header}const key = 'succeed'\nexport const s = Effect[key](1)`,
    // Not a banned name, even one every object inherits.
    `${header}export const s = Effect.constructor`,
    // Not Effect's: a unified processor's sync run.
    'export const d = (processor: { runSync: (tree: unknown) => unknown }) => processor.runSync({})',
  ],
  invalid: [
    ...['forkChild', 'forkIn', 'forkScoped', 'forkDetach'].map((name) => ({
      code: `${header}export const f = Effect.${name}(Effect.void)`,
      errors: [{ message: new RegExp(`^Effect\\.${name}: fork through forkObserved`) }],
    })),
    {
      // The pipe form is the same fork.
      code: `${header}export const f = Effect.void.pipe(Effect.forkScoped)`,
      errors: [{ message: /forkObserved/ }],
    },
    ...['runFork', 'runForkWith', 'runPromise', 'runPromiseExit', 'runSync', 'runCallback'].map((name) => ({
      code: `${header}export const r = () => Effect.${name}(Effect.void)`,
      errors: [{ message: new RegExp(`^Effect\\.${name}: start work from a callback through makeRunObserved`) }],
    })),
    {
      code: `${header}export const r = (runtime: { runFork: (e: unknown) => void }) => runtime.runFork(Effect.void)`,
      errors: [{ message: /^\.runFork: start work from a callback through makeRunObserved/ }],
    },
    // Aliases: a namespace, `Effect` renamed, the root module, and named imports.
    {
      code: "import * as E from 'effect/Effect'\nexport const f = E.forkChild(E.void)",
      errors: [{ message: /^Effect\.forkChild: fork through forkObserved/ }],
    },
    {
      code: "import { Effect as Fx } from 'effect'\nexport const r = () => Fx.runPromise(Fx.void)",
      errors: [{ message: /^Effect\.runPromise: start work from a callback/ }],
    },
    {
      code: "import * as effect from 'effect'\nexport const i = effect.Effect.ignore(effect.Effect.void)",
      errors: [{ message: /^Effect\.ignore:/ }],
    },
    {
      code: `${header}import { forkScoped as fork, ignore } from 'effect/Effect'\nexport const f = Effect.void.pipe(fork, ignore)`,
      errors: [{ message: /^Effect\.forkScoped:/ }, { message: /^Effect\.ignore:/ }],
    },
    {
      code: "import { runFork } from 'effect/Effect'\nexport const r = (e: never) => runFork(e)",
      errors: [{ message: /^Effect\.runFork: start work from a callback/ }],
    },
    // String keys, destructuring and re-exports.
    {
      code: `${header}export const f = Effect['forkDetach'](Effect.void)`,
      errors: [{ message: /^Effect\.forkDetach: fork through forkObserved/ }],
    },
    {
      code: "import * as effect from 'effect'\nexport const f = effect['Effect'].forkChild(effect.Effect.void)",
      errors: [{ message: /^Effect\.forkChild:/ }],
    },
    {
      code: `${header}const { forkScoped: fork, runPromise } = Effect\nexport const f = Effect.void.pipe(fork)\nexport const r = () => runPromise(Effect.void)`,
      errors: [{ message: /^Effect\.forkScoped:/ }, { message: /^Effect\.runPromise:/ }],
    },
    {
      code: "export { forkDaemon, succeed, runSync as run } from 'effect/Effect'",
      errors: [{ message: /^Effect\.forkDaemon:/ }, { message: /^Effect\.runSync:/ }],
    },
    {
      code: "export * from 'effect/Effect'",
      errors: [{ message: /^export \* from 'effect\/Effect'/ }],
    },
    {
      code: "export * as Fx from 'effect/Effect'",
      errors: [{ message: /^export \* from 'effect\/Effect'/ }],
    },
    {
      code: `${header}export const i = Effect.ignore(Effect.void)`,
      errors: [{ message: /^Effect\.ignore: a Die passes straight through it/ }],
    },
    {
      // Options do not help: `ignore` logs a typed failure at most, never a Die.
      code: `${header}export const i = Effect.void.pipe(Effect.ignore({ log: true }))`,
      errors: [{ message: /^Effect\.ignore:/ }],
    },
    {
      code: `${header}export const i = Effect.ignoreCause(Effect.void)`,
      errors: [{ message: /^Effect\.ignoreCause: drops a defect, or with \{ log \} logs it without a report id/ }],
    },
    {
      code: `${header}export const t = Effect.void.pipe(Effect.tapError(() => Effect.void))`,
      errors: [{ message: /^Effect\.tapError: a Die skips it\. For a rollback use undoOnFailure/ }],
    },
  ],
})

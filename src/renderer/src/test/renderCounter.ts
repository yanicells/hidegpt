// Adapted from T3 Code (apps/web/test/renderCounter.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

// Counts React commits and component renders through the DevTools hook, so a
// test can say which components a change rendered. React only reports to a
// hook that exists when react-dom initializes: import this before anything
// that imports react-dom (`@testing-library/react`). Bailed-out subtrees
// (child === alternate.child) keep stale PerformedWork flags and are skipped.

type Fiber = {
  readonly tag: number
  readonly elementType: unknown
  readonly return: Fiber | null
  readonly flags: number
  readonly alternate: Fiber | null
  readonly child: Fiber | null
  readonly sibling: Fiber | null
}

export type RenderReport = {
  readonly commits: number
  /** Renders by component name. */
  readonly components: Readonly<Record<string, number>>
}

// Function, class, forwardRef and simple memo components. A memo with a compare
// function (14) renders its function as a child fiber, which counts under the
// memo's name, so the memo fiber itself is skipped and one render counts once.
const COMPONENT_TAGS = new Set([0, 1, 11, 15])
const PERFORMED_WORK = 1
const MEMO = 14

type Named = { displayName?: string; name?: string }

// Names a memo component after the memo, so a `displayName` set on it counts: a
// simple memo's fiber has the memo as `elementType`, and a memo with a compare
// function renders its function as a child fiber.
function nameOf(fiber: Fiber): string | null {
  const parent = fiber.return
  const memo = parent?.tag === MEMO && (parent.elementType as { type?: unknown }).type === fiber.elementType
  const type = (memo ? parent : fiber).elementType as (Named & { type?: Named; render?: Named }) | null
  if (!type || (typeof type !== 'object' && typeof type !== 'function')) return null
  const inner = type.type ?? type.render ?? type
  return type.displayName || inner.displayName || inner.name || 'Anonymous'
}

type CounterState = { on: boolean; commits: number; counts: Map<string, number> }

// A test file and its setup can load this module twice; both share one hook and one state.
const STATE = Symbol.for('hidegpt.renderCounter')
const state = ((globalThis as { [STATE]?: CounterState })[STATE] ??= { on: false, commits: 0, counts: new Map() })

/** Adds the components that rendered under `fiber` and returns how many did. */
function visit(fiber: Fiber | null): number {
  let rendered = 0
  for (let node = fiber; node; node = node.sibling) {
    const performed = COMPONENT_TAGS.has(node.tag) && (node.flags & PERFORMED_WORK) === PERFORMED_WORK
    const name = performed ? nameOf(node) : null
    if (name) {
      state.counts.set(name, (state.counts.get(name) ?? 0) + 1)
      rendered += 1
    }
    const skipped = node.alternate !== null && node.child === node.alternate.child && !performed
    if (node.child && !skipped) rendered += visit(node.child)
  }
  return rendered
}

if (!('__REACT_DEVTOOLS_GLOBAL_HOOK__' in globalThis)) {
  Object.assign(globalThis, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: unknown, root: { current: Fiber }) => {
        // Commits that render no component (layout-only batches) vary with timing.
        if (state.on && visit(root.current.child) > 0) state.commits += 1
      },
    },
  })
}

export function startCounting(): void {
  state.commits = 0
  state.counts = new Map()
  state.on = true
}

export function stopCounting(): RenderReport {
  state.on = false
  return { commits: state.commits, components: Object.fromEntries(state.counts) }
}

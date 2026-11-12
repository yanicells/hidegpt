import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import type { ProviderSessionManager } from './ProviderSessionManager'

/**
 * `HIDEGPT_SCREENSHOT=<dir>` (with `HIDEGPT_FAKE=1`): walks Home, a project,
 * the New document dialog, a document, the narrow layouts, and the library
 * switch, saving a PNG of each, then quits. A smoke test of the real app.
 */
export const captureScreenshots = (win: BrowserWindow, manager: ProviderSessionManager['Service'], dir: string) =>
  Effect.gen(function* () {
    mkdirSync(dir, { recursive: true })
    const run = <A>(script: string) => Effect.promise(() => win.webContents.executeJavaScript(script) as Promise<A>)
    const pause = (ms: number) => Effect.sleep(`${ms} millis`)
    const shoot = (name: string) =>
      Effect.promise(() => win.capturePage()).pipe(
        Effect.map((image) => writeFileSync(join(dir, `${name}.png`), image.toPNG())),
      )
    const waitFor = (selector: string, what: string) =>
      run(`new Promise((resolve, reject) => {
        const started = Date.now()
        const tick = () => {
          if (document.querySelector(${JSON.stringify(selector)})) resolve(true)
          else if (Date.now() - started > 8000) reject(new Error(${JSON.stringify(`${what} did not appear`)}))
          else setTimeout(tick, 50)
        }
        tick()
      })`)
    const click = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const clickButton = (scope: string, text: string) =>
      run(
        `Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find((b) => b.textContent === ${JSON.stringify(text)}).click()`,
      )

    yield* manager.snapshots.pipe(
      Stream.filter((snapshot) => snapshot.status !== 'connecting'),
      Stream.runHead,
    )
    win.show()
    yield* waitFor('[data-testid="app"]', 'The app')
    yield* pause(200)
    yield* shoot('home')
    yield* click('[aria-label="List view"]')
    yield* pause(100)
    yield* shoot('home-list')
    yield* click('[aria-label="Grid view"]')

    const snapshot = yield* manager.snapshot
    const project = snapshot.projects[0]
    if (project) {
      yield* click(`[data-testid="project-${project.id}"]`)
      yield* pause(100)
      yield* shoot('project')
      yield* clickButton('button', 'New document')
      yield* pause(100)
      yield* shoot('new-document')
      yield* clickButton('dialog button', 'Create document')
      yield* run(`new Promise((resolve, reject) => {
        const started = Date.now()
        const check = () => {
          const composer = document.querySelector('[data-testid="composer"]')
          if (composer && !document.querySelector('dialog')) {
            if (document.activeElement !== composer) reject(new Error('New document composer did not receive focus'))
            else resolve(true)
          } else if (Date.now() - started > 8000) reject(new Error('Document creation did not complete'))
          else setTimeout(check, 50)
        }
        check()
      })`)
      // The composer exists before the new page has painted.
      yield* pause(200)
      yield* shoot('new-document-ready')
    }

    // The document from before the walk: a just-created one would be empty.
    const first = Option.fromNullishOr(snapshot.threads[0])
    yield* Option.match(first, {
      onNone: () => manager.dispatch({ op: 'newDocument' }),
      onSome: (doc) => manager.dispatch({ op: 'openThread', threadId: doc.id }),
    })
    yield* waitFor('[data-testid="document"]', 'The document')
    yield* pause(200)
    yield* shoot('document')
    win.setSize(760, 700)
    yield* pause(100)
    yield* shoot('document-narrow')
    yield* manager.dispatch({ op: 'goHome' })
    yield* pause(100)
    yield* shoot('home-narrow')

    yield* click('[data-testid="library-opencode"]')
    yield* waitFor('[data-testid="library-opencode"][aria-pressed="true"]', 'The OpenCode library')
    yield* waitFor('[data-testid="docs-home"]', 'OpenCode Home')
    yield* shoot('opencode-home')
    yield* click('[data-testid="library-codex"]')
    yield* pause(100)
    const returnedHome = yield* run<boolean>(`!!document.querySelector('.route-home .home')`)
    if (!returnedHome) return yield* Effect.die(new Error('Switching back to Codex did not return to its library'))
  })

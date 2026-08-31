import React from 'react'
import { describe, expect, it } from 'vitest'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'

import { HideGptApp } from './app'
import { createFakeTransport } from './src/codex/fake'
import { CodexSession } from './src/codex/session'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

async function mountHome() {
  const session = new CodexSession(() => createFakeTransport())
  const { render, renderer } = createTestRoot({ width: 1280, height: 840 })
  render(<HideGptApp session={session} />)
  const app = await connectTest(renderer)
  await app.getByTestId('new-doc').waitFor({ timeoutMs: 10_000 })
  return { app, renderer, session }
}

describeNative('docs home', () => {
  it('paints the Docs chrome and recent threads', async () => {
    const { app, renderer } = await mountHome()
    const painted = renderer.getPaintedText()
    expect(painted).toContain('Docs')
    expect(painted).toContain('File')
    expect(painted).toContain('Photosynthesis')
    expect(painted).toContain('Chem lab')
    expect(painted).toContain('Start a new document')
    expect(painted).toContain('Blank')
    expect(painted).toContain('Recent documents')
    await app.close()
  })

  it('opens a thread as a document', async () => {
    const { app, renderer } = await mountHome()
    await app.getByTestId('thread-thr_1').click()
    await app.getByTestId('composer').waitFor({ timeoutMs: 10_000 })
    expect(renderer.getPaintedText()).toContain('Photosynthesis')
    expect(renderer.getPaintedText()).toContain('Type a question')
    await app.close()
  }, 20_000)

  it('opens the File menu', async () => {
    const { app, renderer } = await mountHome()
    await app.getByTestId('menu-file').click()
    expect(renderer.getPaintedText()).toContain('New document')
    expect(renderer.getPaintedText()).toContain('Open folder…')
    await app.close()
  })

  it('shows a search field on the homepage', async () => {
    const { app, renderer } = await mountHome()
    await app.getByTestId('home-search').waitFor({ timeoutMs: 10_000 })
    expect(renderer.getPaintedText()).toContain('Search documents')
    await app.close()
  })
})

/// <reference types="electron-vite/node" />
// Adapted from T3 Code (apps/desktop/src/boot.ts, apps/desktop/src/compileCache.ts) at commit 8a14762c,
// and apps/desktop/src/app/DesktopAppIdentity.ts at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { app } from 'electron'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'

// Boots main: V8 keeps the compiled main-process code between launches, so
// later starts skip parsing it. The cache has to be on before the app's
// modules load, hence the dynamic import below.

// The name decides where userData lives, so it comes before any path is read.
app.setName('Docs')
// Run from source, the About panel would otherwise show Electron's own name,
// build number and copyright.
const version = app.getVersion()
app.setAboutPanelOptions({ applicationName: 'Docs', applicationVersion: version, version, copyright: '' })
try {
  enableCompileCache(join(app.getPath('userData'), 'compile-cache'))
} catch {
  // Starting without the cache is only slower.
}

// Electron waits for this before emitting `ready`, so the app's
// before-ready setup (privileged schemes) still runs in time.
await import('./app')

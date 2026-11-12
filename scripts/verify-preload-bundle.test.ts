import { describe, expect, it } from 'vitest'

import { verifyPreloadBundle } from './verify-preload-bundle.ts'

const API = ['getSnapshot', 'onSnapshot', 'onMenu', 'dispatch', 'pickDirectory', 'saveImage']

/** A CJS preload like the built one, exposing `methods` on window.hidegpt. */
const preload = (methods = API, prelude = '') => `"use strict";
${prelude}
const electron = require("electron");
const snapshot = electron.ipcRenderer.sendSync("snapshot-now");
electron.contextBridge.exposeInMainWorld("hidegpt", {
  ${methods.map((name) => `${name}: () => snapshot`).join(',\n  ')},
  platform: process.platform,
});`

describe('verifyPreloadBundle', () => {
  it('accepts a sandbox-safe preload that exposes the whole API', () => {
    expect(() => verifyPreloadBundle(preload())).not.toThrow()
  })

  it('rejects a module a sandboxed preload cannot load', () => {
    expect(() => verifyPreloadBundle(preload(API, 'require("node:fs");'))).toThrow(/node:fs/)
  })

  it('rejects dynamic loading', () => {
    expect(() => verifyPreloadBundle(preload(API, 'import("electron");'))).toThrow(/dynamic import/)
    expect(() => verifyPreloadBundle(preload(API, 'const name = "electron"; require(name);'))).toThrow(
      /dynamic require/,
    )
  })

  it('rejects a preload missing part of the API', () => {
    expect(() => verifyPreloadBundle(preload(API.filter((name) => name !== 'dispatch')))).toThrow(/dispatch/)
  })
})

// Adapted from T3 Code (apps/server/src/provider/CodexProvider.ts, codexAppServerEnvironment and
// buildCodexInitializeParams) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { version } from '../../package.json'

/** The name Docs gives `codex app-server`: the app's own neutral name, never another product's. */
export const CODEX_CLIENT_NAME = 'docs-desktop'

/** `initialize`'s `clientInfo`. */
export const CODEX_CLIENT_INFO = { name: CODEX_CLIENT_NAME, title: 'Docs', version } as const

/**
 * The app server's environment. Like T3 Code, the originator is set at spawn
 * as well as in `initialize`: Codex refreshes its model list before
 * `initialize` arrives, and without it that refresh runs, and fills the shared
 * cache, as the plain CLI. The originator can change which models Codex lists.
 */
export const CODEX_ENV = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME } as const

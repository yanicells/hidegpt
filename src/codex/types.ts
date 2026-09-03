import type { Account } from '../generated/codex/v2/Account'
import type { CollaborationModeMask } from '../generated/codex/v2/CollaborationModeMask'
import type { GetAccountRateLimitsResponse } from '../generated/codex/v2/GetAccountRateLimitsResponse'
import type { McpServerStatus } from '../generated/codex/v2/McpServerStatus'
import type { Model } from '../generated/codex/v2/Model'
import type { Project } from '../generated/codex/v2/Project'
import type { Thread } from '../generated/codex/v2/Thread'

import type { Block } from './blocks'

export type Provider = 'codex' | 'opencode'

export type Route = { kind: 'home' } | { kind: 'doc'; threadId: string }

export type Snapshot = {
  status: 'connecting' | 'ready' | 'error'
  provider: Provider
  error: string | null
  account: Account | null
  requiresAuth: boolean
  models: Model[]
  model: string | null
  effort: string | null
  /** Selected service-tier id (speed). Null means the thread default. Codex only. */
  speed: string | null
  collaborationModes: CollaborationModeMask[]
  collaborationMode: string | null
  projects: Project[]
  threads: Thread[]
  cwd: string
  rateLimits: GetAccountRateLimitsResponse | null
  route: Route
  title: string
  blocks: Block[]
  streaming: boolean
  loginUrl: string | null
  folderDraft: string
  showFolder: boolean
  olderTurnsCursor: string | null
  loadingOlder: boolean
  search: string
  mcpServers: McpServerStatus[]
}

export function emptySnapshot(cwd = ''): Snapshot {
  return {
    status: 'connecting',
    provider: 'codex',
    error: null,
    account: null,
    requiresAuth: false,
    models: [],
    model: null,
    effort: null,
    speed: null,
    collaborationModes: [],
    collaborationMode: null,
    projects: [],
    threads: [],
    cwd,
    rateLimits: null,
    route: { kind: 'home' },
    title: 'Docs',
    blocks: [],
    streaming: false,
    loginUrl: null,
    folderDraft: cwd,
    showFolder: false,
    olderTurnsCursor: null,
    loadingOlder: false,
    search: '',
    mcpServers: [],
  }
}

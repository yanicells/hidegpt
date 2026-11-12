import type { Block, Capabilities, ProviderId, Route, Snapshot } from './contracts'

/**
 * Renderer-safe entry to the domain model: the types derived from the
 * Schema contracts in `./contracts` (type-only, so no Effect in the renderer
 * bundle) plus small plain helpers. See docs/architecture.md §1.
 */
export type {
  AccountSummary,
  AgentBlock,
  ApprovalBlock,
  ApprovalField,
  ApprovalQuestion,
  ApprovalReply,
  Block,
  CalloutBlock,
  Capabilities,
  DocSummary,
  ModelOption,
  ModeOption,
  ProjectSummary,
  ProviderId,
  ProviderStatus,
  Route,
  Skill,
  Snapshot,
  ToolServer,
  UserBlock,
} from './contracts'

export const CAPABILITIES: Record<ProviderId, Capabilities> = {
  codex: { login: true, connectTools: true, createProjects: true, gitProjects: false },
  opencode: { login: false, connectTools: false, createProjects: true, gitProjects: true },
  claude: { login: false, connectTools: false, createProjects: false, gitProjects: false },
}

export const HOME: Route = { kind: 'home' }
export const NO_BLOCKS: ReadonlyArray<Block> = []

export function emptySnapshot(cwd = '', provider: ProviderId = 'codex'): Snapshot {
  return {
    provider,
    capabilities: CAPABILITIES[provider],
    status: 'connecting',
    error: null,
    account: null,
    requiresAuth: false,
    loginUrl: null,
    models: [],
    model: null,
    effort: null,
    serviceTier: null,
    collaborationModes: [],
    collaborationMode: null,
    projects: [],
    threads: [],
    cwd,
    search: '',
    mcpServers: [],
    skills: [],
    route: HOME,
    title: 'Docs',
    blocks: NO_BLOCKS,
    streaming: false,
    stopping: false,
    hasOlder: false,
    loadingOlder: false,
    openingThreadId: null,
  }
}

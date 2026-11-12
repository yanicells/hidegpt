import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname } from 'node:path'

import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type {
  CanUseTool,
  EffortLevel,
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions as ClaudeSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
import * as FiberSet from 'effect/FiberSet'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { logDefects, reportDefect } from '../provider/DefectReport'
import {
  BinaryMissingError,
  DEFECT_MESSAGE,
  NotLoggedInError,
  ProviderRequestError,
  ProviderTimeoutError,
  type ProviderError,
} from '../provider/errors'
import type { ProcessSupervisor } from '../provider/ProcessSupervisor'
import { reportTurnFailure } from '../provider/turnFailure'
import type {
  AdapterEvent,
  OpenedThread,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
  TurnSettings,
} from '../provider/ProviderAdapter'
import { CAPABILITIES, type Block, type DocSummary } from '../shared/model'
import {
  askedQuestions,
  blocksFromSessionMessages,
  emptyStreamState,
  isSignedIn,
  permissionBlock,
  permissionBlockId,
  questionAnswers,
  questionBlock,
  readMessage,
  sessionTitle,
  toDoc,
  toModels,
  toSkills,
  type AskedQuestion,
  type StreamState,
} from './mapping'
import { packagedClaudeExecutable } from './executable'

/**
 * The Claude Agent SDK as a HideGPT provider. The SDK runs Anthropic's
 * unmodified Claude Code with the person's own login; Docs never reads,
 * stores, or offers Claude credentials, and has no sign-in flow.
 *
 * Each document that is answering owns one long-lived `query()` fed by a
 * prompt queue (T3 Code's streaming-input pattern). It starts on the first
 * send, settles its turn on the `result` frame, and settles it as failed if
 * Claude Code exits first; the next send then resumes the transcript.
 *
 * The streaming-input query per document, the probe and the approval bridge are
 * adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
 * and apps/server/src/provider/ClaudeProvider.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */

/** The SDK functions the adapter uses; tests and demo mode pass an in-process fake. */
export type ClaudeSdk = Pick<
  typeof ClaudeAgentSdk,
  'query' | 'listSessions' | 'getSessionMessages' | 'getSessionInfo' | 'renameSession'
>

const provider = 'claude' as const
const DEFAULT_DEADLINE = 30
/** Claude Code can block at startup (a slow MCP server, an auth prompt); T3 Code waits 25 s. */
export const PROBE_SECONDS = 25
export const INTERRUPT_SECONDS = 10
const PAGE = 60
const MAX_DOCS = 500
const SIGN_IN = 'Claude signs in outside Docs. Run `claude` in a terminal and log in, then use Tools → Refresh.'
const EFFORTS: ReadonlyArray<EffortLevel> = ['low', 'medium', 'high', 'xhigh', 'max']
const effortOf = (value: string | null): EffortLevel | null => EFFORTS.find((effort) => effort === value) ?? null
const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const errorDetail = (cause: unknown) =>
  (cause instanceof Error && cause.message.trim()) || 'Claude Code could not do that.'

/** One SDK call with its deadline; failures become HideGPT's tagged errors. */
const request = <A>(operation: string, run: () => Promise<A>, seconds = DEFAULT_DEADLINE) =>
  Effect.tryPromise({
    try: run,
    catch: (cause): ProviderError => new ProviderRequestError({ provider, operation, detail: errorDetail(cause) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () => Effect.fail(new ProviderTimeoutError({ provider, operation, seconds })),
    }),
  )

const rejected = (operation: string, detail: string) => new ProviderRequestError({ provider, operation, detail })

/** A prompt that never yields, so a probe starts Claude Code without sending anything to the model. */
// oxlint-disable-next-line require-yield -- it must never yield
async function* silentPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function imageBlock(path: string) {
  const media_type = IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'
  const data = (await readFile(path)).toString('base64')
  return { type: 'image' as const, source: { type: 'base64' as const, media_type, data } }
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300)

/** A document whose Claude Code process is running. */
type Live = {
  readonly threadId: string
  readonly query: Query
  readonly prompts: Queue.Queue<SDKUserMessage, Cause.Done>
  readonly state: StreamState
  model: string | null
  effort: EffortLevel | null
  turn: boolean
  /** Counts sends, so a stop timer only settles the turn it was started for. */
  turns: number
  stopping: boolean
  settled: boolean
  stderr: string | undefined
}

/** What Docs knows about a document between turns. */
type ThreadInfo = {
  cwd: string
  /** A transcript exists, so the next process resumes it instead of starting it. */
  saved: boolean
  /** A name given before the first message, applied once the transcript exists. */
  pendingTitle: string | null
}

type PendingApproval = {
  readonly threadId: string
  readonly input: Record<string, unknown>
  readonly questions: ReadonlyArray<AskedQuestion> | null
  readonly decision: Deferred.Deferred<PermissionResult>
}

const loadRealSdk = (): Promise<ClaudeSdk> => import('@anthropic-ai/claude-agent-sdk')

/**
 * `loadSdk` defaults to a lazy import, so the SDK loads only when the Claude library connects.
 * With a `supervisor`, every Claude Code process is spawned through it (own process group,
 * orphan ledger, stopped with the session); without one (tests, demo) the SDK spawns its own.
 */
export function make(
  loadSdk: () => Promise<ClaudeSdk> = loadRealSdk,
  supervisor?: ProcessSupervisor['Service'],
): ProviderAdapter {
  return {
    id: provider,
    capabilities: CAPABILITIES.claude,
    openSession: Effect.gen(function* () {
      const sdk = yield* Effect.tryPromise({
        try: loadSdk,
        catch: () => new BinaryMissingError({ provider, command: '@anthropic-ai/claude-agent-sdk' }),
      })
      // Set only in a packaged app, where the binary sits outside app.asar.
      const executable = packagedClaudeExecutable()
      const binary = executable ? { pathToClaudeCodeExecutable: executable } : {}
      const events = yield* Queue.unbounded<AdapterEvent>()
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      const emit = (event: AdapterEvent) => Queue.offer(events, event).pipe(Effect.asVoid)
      const scope = yield* Scope.Scope
      const fork = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.asVoid(Effect.forkIn(logDefects(Effect.ignore(effect)), scope))
      // SDK callbacks run in the session scope with its services (its logger and log
      // annotations), so closing the library interrupts them.
      const runPromise = yield* FiberSet.makeRuntimePromise()
      const spawn = supervisor ? yield* supervisor.callbackSpawner : null
      /**
       * Starts Claude Code under the supervisor. The SDK's env is passed through untouched;
       * only its stderr is read, for the last line of a failed start.
       */
      const spawnOptions = (onStderr: (text: string) => void) =>
        spawn
          ? { spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => spawn({ ...options, onStderr }) }
          : { stderr: onStderr }

      const threads = new Map<string, ThreadInfo>()
      const lives = new Map<string, Live>()
      const approvals = new Map<string, PendingApproval>()
      /** The full block list of each open document, for "Load earlier". */
      const history = new Map<string, ReadonlyArray<Block>>()
      const probes = new Map<string, Deferred.Deferred<SDKControlInitializeResponse, ProviderError>>()

      const infoOf = (threadId: string): ThreadInfo => {
        let info = threads.get(threadId)
        if (!info) {
          info = { cwd: homedir(), saved: true, pendingTitle: null }
          threads.set(threadId, info)
        }
        return info
      }
      const dirOption = (threadId: string) => {
        const cwd = threads.get(threadId)?.cwd
        return cwd ? { dir: cwd } : {}
      }

      // ---- probe ------------------------------------------------------------------

      /**
       * Starts Claude Code just long enough to read its models, commands and login.
       * Adapted from T3 Code (apps/server/src/provider/ClaudeProvider.ts) at commit 8a14762c.
       * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
       */
      const probe = (cwd: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const abort = new AbortController()
            const query = sdk.query({
              prompt: silentPrompt(abort.signal),
              options: {
                ...binary,
                cwd,
                abortController: abort,
                // As in T3 Code's capabilities probe: no tools, hooks or MCP servers start.
                allowedTools: [],
                mcpServers: {},
                strictMcpConfig: true,
                settings: { disableAllHooks: true },
                ...spawnOptions(() => {}),
              },
            })
            return { abort, query }
          }),
          ({ query }) => request('initialize', () => query.initializationResult(), PROBE_SECONDS),
          ({ abort, query }) =>
            Effect.sync(() => {
              abort.abort()
              query.close()
            }),
        )

      /**
       * One probe per folder at a time (a refresh asks for the catalog and the skills
       * together). It runs in the session scope, so a caller that gives up cannot
       * strand the others, and closing the library stops it.
       */
      const probeIn = (cwd: string) =>
        Effect.gen(function* () {
          let pending = probes.get(cwd)
          if (!pending) {
            const created = Deferred.makeUnsafe<SDKControlInitializeResponse, ProviderError>()
            probes.set(cwd, created)
            pending = created
            yield* Effect.forkIn(
              probe(cwd).pipe(
                Effect.exit,
                Effect.flatMap((exit) =>
                  Effect.sync(() => probes.delete(cwd)).pipe(Effect.andThen(Deferred.done(created, exit))),
                ),
              ),
              scope,
            )
          }
          return yield* Deferred.await(pending)
        })

      // ---- approvals ----------------------------------------------------------------

      const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

      /**
       * Bridges `canUseTool` to an approval block, one Deferred per request.
       * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) at commit 8a14762c.
       * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
       */
      const askPermission = (
        threadId: string,
        tool: string,
        input: Record<string, unknown>,
        options: Parameters<CanUseTool>[2],
      ) => {
        const id = permissionBlockId(options.toolUseID)
        return Effect.gen(function* () {
          const questions = tool === 'AskUserQuestion' ? askedQuestions(input) : null
          const decision = yield* Deferred.make<PermissionResult>()
          approvals.set(id, { threadId, input, questions, decision })
          const block = questions ? questionBlock(id, questions) : permissionBlock(id, tool, input, options.displayName)
          yield* emit({ type: 'block', threadId, block })
          // Claude Code withdraws the request when the turn stops.
          const withdrawn = Effect.callback<PermissionResult>((resume) => {
            const abort = () =>
              resume(
                emit({ type: 'resolved', threadId, blockId: id, resolved: 'skipped' }).pipe(
                  Effect.as(deny('Cancelled.')),
                ),
              )
            if (options.signal.aborted) abort()
            else options.signal.addEventListener('abort', abort, { once: true })
            return Effect.sync(() => options.signal.removeEventListener('abort', abort))
          })
          return yield* Effect.raceFirst(Deferred.await(decision), withdrawn)
        }).pipe(Effect.ensuring(Effect.sync(() => approvals.delete(id))))
      }

      const cancelApprovals = (threadId: string) =>
        Effect.forEach(
          [...approvals].filter(([, pending]) => pending.threadId === threadId),
          ([id, pending]) =>
            Effect.gen(function* () {
              approvals.delete(id)
              if (yield* Deferred.succeed(pending.decision, deny('The document closed.'))) {
                yield* emit({ type: 'resolved', threadId, blockId: id, resolved: 'skipped' })
              }
            }),
          { discard: true },
        )

      // ---- live queries -----------------------------------------------------------

      /**
       * Ends a document's process once. A turn still running is settled here, so the
       * page never stays on "Working…" after Claude Code is gone.
       */
      const settle = (live: Live, error: string | undefined) =>
        Effect.gen(function* () {
          if (live.settled) return
          live.settled = true
          if (lives.get(live.threadId) === live) lives.delete(live.threadId)
          yield* Queue.end(live.prompts)
          live.query.close()
          yield* cancelApprovals(live.threadId)
          if (!live.turn) return
          live.turn = false
          yield* emit({ type: 'turnEnded', threadId: live.threadId, ...(live.stopping || !error ? {} : { error }) })
        })

      const stoppedMessage = (live: Live, exit: Exit.Exit<void, unknown>) => {
        const detail = live.stderr ?? (exit._tag === 'Failure' ? errorDetail(Cause.squash(exit.cause)) : undefined)
        return `Claude Code stopped before it finished${detail ? ` (${detail})` : ''}. Send your message again to continue.`
      }

      const afterTurn = (live: Live) =>
        Effect.gen(function* () {
          const info = infoOf(live.threadId)
          info.saved = true
          const title = info.pendingTitle
          if (!title) return
          info.pendingTitle = null
          yield* Effect.ignore(
            request('renameSession', () => sdk.renameSession(live.threadId, title, dirOption(live.threadId))),
          )
        })

      const onMessage = (live: Live, message: SDKMessage) =>
        Effect.gen(function* () {
          if (message.type === 'assistant') infoOf(live.threadId).saved = true
          for (const emission of readMessage(live.state, message)) {
            if (emission.type === 'block')
              yield* emit({ type: 'block', threadId: live.threadId, block: emission.block })
            else if (emission.type === 'text') {
              yield* emit({
                type: 'text',
                threadId: live.threadId,
                blockId: emission.blockId,
                delta: emission.delta,
                create: { kind: 'agent' },
              })
            } else {
              yield* afterTurn(live)
              if (!live.turn) continue
              live.turn = false
              const failure = live.stopping ? undefined : emission.failure
              live.stopping = false
              // The page gets Docs' sentence and a report id; the provider's text goes to the log.
              const error = failure ? yield* reportTurnFailure('claude', failure) : undefined
              yield* emit({ type: 'turnEnded', threadId: live.threadId, ...(error ? { error } : {}) })
            }
          }
        })

      /** Reads one process's frames until it exits, then settles whatever it left running. */
      const consume = (live: Live) =>
        Stream.fromAsyncIterable(live.query, (cause) => cause).pipe(
          Stream.runForEach((message) => onMessage(live, message)),
          Effect.exit,
          // A die is a Docs bug reading a frame: report it, and keep its raw text off the page.
          Effect.flatMap((exit) =>
            exit._tag === 'Failure' && Cause.hasDies(exit.cause)
              ? Effect.flatMap(reportDefect(exit.cause), () => settle(live, DEFECT_MESSAGE))
              : settle(live, stoppedMessage(live, exit)),
          ),
        )

      const startLive = (threadId: string, settings: TurnSettings) =>
        Effect.gen(function* () {
          const info = infoOf(threadId)
          // A process that exited before any answer may still have written the transcript;
          // starting it again under the same id would then fail, so resume it instead.
          if (!info.saved) {
            const existing = yield* Effect.orElseSucceed(
              request('getSessionInfo', () => sdk.getSessionInfo(threadId, dirOption(threadId)), 10),
              () => undefined,
            )
            if (existing) info.saved = true
          }
          const prompts = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
          const effort = effortOf(settings.effort)
          const live: Live = {
            threadId,
            prompts,
            state: emptyStreamState(),
            model: settings.model,
            effort,
            turn: false,
            turns: 0,
            stopping: false,
            settled: false,
            stderr: undefined,
            query: sdk.query({
              prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
              options: {
                ...binary,
                cwd: existsSync(info.cwd) ? info.cwd : homedir(),
                ...(info.saved ? { resume: threadId } : { sessionId: threadId }),
                ...(settings.model ? { model: settings.model } : {}),
                ...(effort ? { effort } : {}),
                includePartialMessages: true,
                canUseTool: (tool, input, options) =>
                  runPromise(
                    askPermission(threadId, tool, input, options).pipe(
                      // A Docs bug building the request: report it and refuse the tool, so the turn goes on.
                      Effect.catchCauseIf(
                        (cause) => !Cause.hasInterruptsOnly(cause),
                        (cause) => Effect.as(reportDefect(cause), deny(DEFECT_MESSAGE)),
                      ),
                    ),
                  ),
                ...spawnOptions((data) => {
                  live.stderr = lastLine(data) ?? live.stderr
                }),
              },
            }),
          }
          lives.set(threadId, live)
          yield* fork(consume(live))
          return live
        })

      /** A running process adopts the toolbar's model and effort before the next turn. */
      const applySettings = (live: Live, settings: TurnSettings) =>
        Effect.gen(function* () {
          if (settings.model && settings.model !== live.model) {
            const model = settings.model
            yield* request('setModel', () => live.query.setModel(model), 10)
            live.model = model
          }
          const effort = effortOf(settings.effort)
          if (effort && effort !== live.effort) {
            yield* request('applyFlagSettings', () => live.query.applyFlagSettings({ effortLevel: effort }), 10)
            live.effort = effort
          }
        })

      const userContent = (input: TurnInput) =>
        Effect.tryPromise({
          try: async (): Promise<SDKUserMessage['message']['content']> => {
            const pictures = await Promise.all(input.images.map(imageBlock))
            // Claude Code expands a leading /name into that skill, as it does when typed in the terminal.
            const prompt = input.skill ? `/${input.skill.name} ${input.text}`.trim() : input.text
            return [...pictures, ...(prompt ? [{ type: 'text' as const, text: prompt }] : [])]
          },
          catch: () => rejected('send', 'Docs could not read an attached file.'),
        })

      const pageOf = (blocks: ReadonlyArray<Block>, end: number) => {
        const start = Math.max(0, end - PAGE)
        return { blocks: blocks.slice(start, end), cursor: start > 0 ? String(start) : null }
      }

      const readHistory = (threadId: string) =>
        request('getSessionMessages', () => sdk.getSessionMessages(threadId, dirOption(threadId))).pipe(
          Effect.map(blocksFromSessionMessages),
          Effect.tap((blocks) => Effect.sync(() => history.set(threadId, blocks))),
        )

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...lives.values()], (live) => settle(live, 'Docs closed this library.'), { discard: true }),
      )

      const session: ProviderSession = {
        events: Stream.fromQueue(events),
        // There is no shared process: each document's Claude Code ends on its own.
        awaitExit: Effect.never,

        loadCatalog: Effect.gen(function* () {
          const init = yield* probeIn(homedir())
          if (!isSignedIn(init.account)) return yield* Effect.fail(new NotLoggedInError({ provider, hint: SIGN_IN }))
          return {
            account: { kind: 'local' as const, label: init.account.email || 'Claude Code' },
            requiresAuth: false,
            models: toModels(init.models),
            modes: [],
            defaultMode: null,
            projects: [],
            tools: [],
          }
        }),

        listDocs: (search) =>
          Stream.fromEffect(
            request('listSessions', () => sdk.listSessions({ limit: MAX_DOCS })).pipe(
              Effect.map((infos): ReadonlyArray<DocSummary> => {
                const needle = search.trim().toLowerCase()
                return infos.flatMap((info) => {
                  if (info.cwd && !threads.has(info.sessionId)) {
                    threads.set(info.sessionId, { cwd: info.cwd, saved: true, pendingTitle: null })
                  }
                  const haystack = `${info.customTitle ?? ''} ${info.summary} ${info.firstPrompt ?? ''}`.toLowerCase()
                  return !needle || haystack.includes(needle) ? [toDoc(info)] : []
                })
              }),
            ),
          ),

        // Project skills depend on the folder; a document's own process answers when it is running.
        listSkills: (cwd) => {
          const live = [...lives.values()].find((item) => threads.get(item.threadId)?.cwd === cwd)
          return live
            ? request('supportedCommands', () => live.query.supportedCommands(), 10).pipe(Effect.map(toSkills))
            : probeIn(existsSync(cwd) ? cwd : homedir()).pipe(Effect.map((init) => toSkills(init.commands)))
        },

        openThread: (threadId, hint) =>
          Effect.gen(function* () {
            if (hint?.cwd) infoOf(threadId).cwd = hint.cwd
            const known = threads.get(threadId)
            const [blocks, info] = yield* Effect.all(
              [
                readHistory(threadId),
                request('getSessionInfo', () => sdk.getSessionInfo(threadId, dirOption(threadId))),
              ],
              { concurrency: 'unbounded' },
            )
            // A document created here has no transcript until its first message.
            if (!info && !blocks.length && known?.saved !== false) {
              return yield* Effect.fail(rejected('getSessionInfo', 'Claude could not find that document.'))
            }
            const thread = infoOf(threadId)
            thread.cwd = info?.cwd || thread.cwd
            if (info) thread.saved = true
            const page = pageOf(blocks, blocks.length)
            return {
              threadId,
              title: thread.pendingTitle || hint?.name || sessionTitle(info),
              blocks: page.blocks,
              olderCursor: page.cursor,
              cwd: thread.cwd,
              streaming: lives.get(threadId)?.turn ?? false,
            } satisfies OpenedThread
          }),

        createThread: (options) =>
          Effect.sync(() => {
            const threadId = randomUUID()
            const cwd = existsSync(options.cwd) ? options.cwd : homedir()
            const title = options.title?.trim() || null
            threads.set(threadId, { cwd, saved: false, pendingTitle: title })
            history.set(threadId, [])
            return {
              threadId,
              title: title ?? 'Untitled document',
              blocks: [],
              olderCursor: null,
              cwd,
            } satisfies OpenedThread
          }),

        loadOlder: (threadId, cursor) =>
          Effect.gen(function* () {
            const end = Number(cursor)
            if (!Number.isInteger(end) || end <= 0) return { blocks: [], cursor: null }
            const blocks = history.get(threadId) ?? (yield* readHistory(threadId))
            return pageOf(blocks, end)
          }),

        messageId: () => randomUUID(),

        send: (threadId, input, settings) =>
          Effect.gen(function* () {
            const content = yield* userContent(input)
            const running = lives.get(threadId)
            if (running?.turn)
              return yield* Effect.fail(rejected('send', 'Claude is still answering. Wait for it, or stop it first.'))
            const live = running && !running.settled ? running : yield* startLive(threadId, settings)
            if (live === running) yield* applySettings(live, settings)
            live.turn = true
            live.turns += 1
            live.stopping = false
            const queued = yield* Queue.offer(live.prompts, {
              type: 'user',
              message: { role: 'user', content },
              parent_tool_use_id: null,
            })
            if (!queued) {
              live.turn = false
              return yield* Effect.fail(rejected('send', 'Claude Code stopped. Send your message again to continue.'))
            }
            yield* emit({ type: 'turnStarted', threadId })
          }),

        /**
         * Asks Claude Code to stop. One that does not end the turn in time (no answer, or an
         * answer but no result frame) is closed, which settles the turn so the next send works.
         */
        interrupt: (threadId) =>
          Effect.gen(function* () {
            const live = lives.get(threadId)
            if (!live?.turn) return
            live.stopping = true
            // Keyed to this turn (as T3 Code keys interrupted turns by id): a turn that ends on
            // its own and a new one stopped later must not be closed by this timer.
            const turn = live.turns
            yield* fork(
              Effect.sleep(Duration.seconds(INTERRUPT_SECONDS)).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    live.turns === turn && live.turn && live.stopping ? settle(live, undefined) : Effect.void,
                  ),
                ),
              ),
            )
            yield* request('interrupt', () => live.query.interrupt(), INTERRUPT_SECONDS).pipe(
              Effect.catch(() => settle(live, undefined)),
              Effect.asVoid,
            )
          }),

        respond: (_threadId, approvalId, reply) =>
          Effect.gen(function* () {
            const pending = approvals.get(approvalId)
            if (!pending)
              return yield* Effect.fail(rejected('respond', 'This request is no longer waiting for an answer.'))
            const result: PermissionResult = pending.questions
              ? reply.accept
                ? questionAnswers(pending.input, pending.questions, reply.answers)
                : deny('The person skipped these questions.')
              : reply.accept
                ? { behavior: 'allow', updatedInput: pending.input }
                : deny('The person skipped this step.')
            approvals.delete(approvalId)
            yield* Deferred.succeed(pending.decision, result)
          }),

        rename: (threadId, name) =>
          Effect.gen(function* () {
            const info = infoOf(threadId)
            // Before the first message there is no transcript to rename yet.
            if (!info.saved) {
              info.pendingTitle = name
              return
            }
            yield* request('renameSession', () => sdk.renameSession(threadId, name, dirOption(threadId)))
          }),

        releaseThread: (threadId) =>
          Effect.gen(function* () {
            history.delete(threadId)
            const live = lives.get(threadId)
            if (live && !live.turn) yield* settle(live, undefined)
          }),
      }
      return session
    }),
  }
}

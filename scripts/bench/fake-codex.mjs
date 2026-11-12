#!/usr/bin/env node
// A stand-in for `codex app-server` used only by the perf bench (scripts/bench/run.mjs).
// It speaks the same JSON-RPC lines over stdio, so the app under test runs its real
// transport, schema decoding and session code against it; nothing in the app is faked.
// It never contacts a model: every answer is generated here from a fixed seed.
//
// The library is deterministic: BENCH_DOCS documents (default 500), where doc-0 holds
// BENCH_TURNS turns (default 300) of Markdown and doc-1 holds 20. Turns page newest
// first, like the real server. The bench scripts each streamed answer over a control
// socket (BENCH_CONTROL=<port>) before the app sends `turn/start`.
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

const DOCS = Number(process.env.BENCH_DOCS ?? 500)
const TURNS = Number(process.env.BENCH_TURNS ?? 300)
const LONG_ID = 'doc-0'
const NOW = Math.floor(Date.now() / 1000)

const WORDS =
  'attention understanding example concept reading argument evidence structure claim reason context method result analysis theory practice'.split(
    ' ',
  )

function sentence(seed, length = 18) {
  const out = []
  for (let i = 0; i < length; i += 1) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length])
  const text = out.join(' ')
  return text[0].toUpperCase() + text.slice(1) + '.'
}

/** About 2.5k characters: paragraphs, a heading, a list, a table and a code block. */
export function longAnswer(seed) {
  const para = (k) => [0, 1, 2, 3].map((j) => sentence(seed + k * 5 + j)).join(' ')
  return [
    `**Answer ${seed}.** ${para(1)}`,
    para(2),
    `### Section ${seed}`,
    ['1. **First.** ' + sentence(seed + 3), '2. **Second.** ' + sentence(seed + 4), '3. **Third.** ' + sentence(seed + 5)].join('\n'),
    [
      '| Term | Meaning | Score |',
      '| --- | --- | --- |',
      ...[0, 1, 2, 3].map((r) => `| ${WORDS[(seed + r) % WORDS.length]} | ${sentence(seed + r, 6)} | ${seed * r} |`),
    ].join('\n'),
    '```ts\n' +
      Array.from({ length: 14 }, (_, i) => `const value${i} = compute(${seed}, ${i}) // ${WORDS[(seed + i) % WORDS.length]}`).join('\n') +
      '\n```',
    para(3),
  ].join('\n\n')
}

/** The answer a scripted turn streams: mixed prose (about 17k characters) or one long code block. */
function streamText(kind, sentinel, answers = 5) {
  if (kind === 'code') {
    return (
      'Here is the full file:\n\n```ts\n' +
      Array.from({ length: 240 }, (_, i) => `export const item${i} = { id: ${i}, label: 'row ${i}', next: item${i + 1} }`).join('\n') +
      `\n\`\`\`\n\nDone. ${sentinel}`
    )
  }
  return Array.from({ length: answers }, (_, i) => longAnswer(9001 + i))
    .concat(`Done. ${sentinel}`)
    .join('\n\n')
}

const userItem = (id, text, clientId = null) => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] })
const agentItem = (id, text) => ({ type: 'agentMessage', id, text })
const turnOf = (id, items, status = 'completed') => ({ id, items, itemsView: 'full', status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 })

function seededTurn(doc, index) {
  const seed = doc * 1000 + index
  const items = [userItem(`q-${doc}-${index}`, `Question ${index}: ${sentence(seed, 10)}`)]
  // Every fifth turn ran a tool, like a real coding thread.
  if (index % 5 === 0) {
    items.push({
      type: 'commandExecution',
      id: `cmd-${doc}-${index}`,
      command: `rg -n concept notes/${index}.md`,
      commandActions: [],
      cwd: '/tmp',
      status: 'completed',
      aggregatedOutput: 'notes.md:12: concept\nnotes.md:40: example',
    })
  }
  items.push(agentItem(`a-${doc}-${index}`, longAnswer(seed)))
  return turnOf(`turn-${doc}-${index}`, items)
}

const preview = `Ideas from the discussion\n\n${sentence(1, 30)}\n\nKey points\n• ${sentence(2, 8)}\n• ${sentence(3, 8)}`
const threads = Array.from({ length: DOCS }, (_, i) => ({
  id: `doc-${i}`,
  sessionId: `doc-${i}`,
  preview,
  ephemeral: false,
  projectId: i % 7 === 0 ? 'course' : null,
  modelProvider: 'openai',
  createdAt: NOW - i * 3 * 3600,
  updatedAt: NOW - i * 3 * 3600,
  recencyAt: NOW - i * 3 * 3600,
  status: { type: 'notLoaded' },
  cwd: '/tmp',
  cliVersion: '0',
  source: 'vscode',
  name: `Document ${i} — ${WORDS[i % WORDS.length]}`,
  turns: [],
}))
const projects = [
  { id: 'course', name: 'Course notes', roots: [{ path: '/tmp/course' }], metadata: {}, position: 0, createdAt: NOW, updatedAt: NOW, recencyAt: NOW },
]

/** Turns per document, oldest first, built on first use. */
const turnsByThread = new Map()
function turnsOf(threadId) {
  let turns = turnsByThread.get(threadId)
  if (!turns) {
    const doc = Number(threadId.replace('doc-', '')) || 0
    const count = threadId === LONG_ID ? TURNS : doc === 1 ? 20 : 4
    turns = Array.from({ length: count }, (_, i) => seededTurn(doc, i))
    turnsByThread.set(threadId, turns)
  }
  return turns
}

/** One page of turns, newest first; the cursor is the index the page ends before. */
function page(threadId, end, limit) {
  const turns = turnsOf(threadId)
  const stop = end ?? turns.length
  const start = Math.max(0, stop - limit)
  return { data: turns.slice(start, stop).reverse(), nextCursor: null, backwardsCursor: start > 0 ? String(start) : null }
}

const SESSION = { modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, reasoningEffort: 'medium' }
const MODEL = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'Normal text',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Low' },
    { reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'high', description: 'High' },
  ],
  defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'standard', name: 'Standard', description: 'Standard speed' }],
  isDefault: true,
}

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const notify = (method, params) => write({ method, params })

// ---- control socket: the bench scripts the next answer and hears when it finished ----
let control = null
/** The plan for the next `turn/start`; unset turns answer with one short paragraph. */
let plan = null
const tell = (message) => control?.write(`${JSON.stringify(message)}\n`)
if (process.env.BENCH_CONTROL) {
  control = connect(Number(process.env.BENCH_CONTROL), '127.0.0.1')
  control.on('error', () => (control = null))
  control.on('connect', () => tell({ role: 'codex', pid: process.pid, docs: DOCS, turns: TURNS }))
  createInterface({ input: control }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.op === 'plan') plan = message
  })
}

let nextTurn = 0
function runTurn(threadId, turnId, input, clientId) {
  const scripted = plan
  plan = null
  const user = { type: 'userMessage', id: `user-${turnId}`, clientId, content: input }
  const itemId = `agent-${turnId}`
  const text = scripted ? streamText(scripted.kind ?? 'prose', scripted.sentinel ?? '', scripted.answers) : 'A short answer with one clear idea.'
  const chunk = scripted?.chunk ?? 8
  const every = scripted?.everyMs ?? 5
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } })
  notify('item/completed', { threadId, turnId, item: user, completedAtMs: Date.now() })
  const started = performance.now()
  let sent = 0
  let deltas = 0
  // Paced against the clock, so a late timer catches up and the answer always takes the same time.
  const tick = () => {
    const due = Math.min(text.length, (Math.floor((performance.now() - started) / every) + 1) * chunk)
    while (sent < due) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text.slice(sent, sent + chunk) })
      sent += chunk
      deltas += 1
    }
    if (sent < text.length) return void setTimeout(tick, every)
    notify('item/completed', { threadId, turnId, item: agentItem(itemId, text), completedAtMs: Date.now() })
    turnsOf(threadId).push(turnOf(turnId, [user, agentItem(itemId, text)]))
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed' } })
    tell({ event: 'turnDone', turnId, emittedAt: Date.now(), deltas, chars: text.length, streamMs: performance.now() - started })
  }
  setTimeout(tick, every)
}

const threadOf = (threadId) => threads.find((thread) => thread.id === threadId) ?? { ...threads[0], id: threadId, sessionId: threadId }

const handlers = {
  initialize: () => ({ userAgent: 'hidegpt-bench', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' }),
  'account/read': () => ({ account: { type: 'chatgpt', email: 'student@school.edu', planType: 'plus' }, requiresOpenaiAuth: false }),
  'account/rateLimits/read': () => ({ rateLimits: { primary: null, secondary: null, credits: null, planType: 'plus' } }),
  'model/list': () => ({ data: [MODEL], nextCursor: null }),
  'project/list': () => ({ data: projects, nextCursor: null }),
  'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
  'collaborationMode/list': () => ({ data: [{ name: 'Default', mode: 'default', model: null, reasoning_effort: null }] }),
  'skills/list': (params) => ({
    data: (params?.cwds ?? []).map((cwd) => ({
      cwd,
      errors: [],
      skills: [{ name: 'study-guide', description: 'Turn notes into a study guide', path: '/tmp/skills/study-guide/SKILL.md', scope: 'user', enabled: true }],
    })),
  }),
  'thread/list': (params) => {
    const search = params?.searchTerm?.toLowerCase()
    const data = search ? threads.filter((thread) => thread.name.toLowerCase().includes(search)) : threads
    const start = Number(params?.cursor ?? 0)
    const end = start + (params?.limit ?? 50)
    // The last page of the library: what the bench waits on when Home mounts only the cards in view.
    if (!search && end >= data.length) tell({ event: 'listed', at: Date.now() })
    return { data: data.slice(start, end), nextCursor: end < data.length ? String(end) : null, backwardsCursor: null }
  },
  'thread/resume': (params) => {
    const thread = threadOf(params.threadId)
    const first = page(params.threadId, null, params.initialTurnsPage?.limit ?? 30)
    return { ...SESSION, thread: { ...thread, turns: [] }, model: MODEL.model, cwd: thread.cwd, initialTurnsPage: first, turnsBackwardsCursor: first.backwardsCursor }
  },
  'thread/turns/list': (params) => page(params.threadId, params.cursor ? Number(params.cursor) : null, params.limit ?? 30),
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'thread/name/set': () => ({}),
  'turn/start': (params) => {
    const turnId = `turn_live_${(nextTurn += 1)}`
    setImmediate(() => runTurn(params.threadId, turnId, params.input, params.clientUserMessageId ?? null))
    return { turn: { id: turnId, items: [], status: 'inProgress' } }
  },
  'turn/interrupt': (params) => {
    notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, items: [], status: 'interrupted' } })
    return {}
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const frame = JSON.parse(line)
  // Notifications from the client (`initialized`) and answers to server requests need no reply.
  if (frame.method === undefined || frame.id === undefined) return
  const handler = handlers[frame.method]
  tell({ event: 'request', method: frame.method })
  if (!handler) return write({ id: frame.id, error: { code: -32601, message: `Unhandled request: ${frame.method}` } })
  write({ id: frame.id, result: handler(frame.params) })
})
process.stdin.on('end', () => process.exit(0))

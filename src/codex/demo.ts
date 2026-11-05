import { DEMO_CONVERSATION, DEMO_DELTA_MS, DEMO_PREVIEW, DEMO_TITLES } from '../provider/demoLibrary'
import { agentItem, makeFakeCodex, stubThread, stubTurn, userItem, type FakeCodex, type Project } from './FakeCodex'

/**
 * The library `HIDEGPT_FAKE=1` shows: fictional course documents over the
 * in-process Codex peer, so screenshots and the bench run the real adapter
 * and session manager without a Codex install. Never uses personal threads.
 */
export function makeDemoCodex(): FakeCodex {
  const now = Math.floor(Date.now() / 1000)
  const threads = DEMO_TITLES.map((title, i) => ({
    ...stubThread(`demo-${i}`, DEMO_PREVIEW, title, i === 0 || i === 2 ? 'course' : i === 1 ? 'workshop' : null),
    updatedAt: now - i * 86400,
    recencyAt: now - i * 86400,
  }))
  const project = (id: string, name: string, position: number, recencyAt: number | null): Project => ({
    id,
    name,
    roots: [{ path: `/tmp/${id}` }],
    metadata: {},
    position,
    createdAt: now,
    updatedAt: now,
    ...(recencyAt === null ? {} : { recencyAt }),
  })
  return makeFakeCodex({
    threads,
    projects: [project('course', 'Course notes', 0, now), project('workshop', 'Writing workshop', 1, now), project('reading', 'Reading journal', 2, null)],
    deltaDelayMs: DEMO_DELTA_MS,
    turns: [
      stubTurn(
        'demo-turn',
        DEMO_CONVERSATION.flatMap((turn, i) => [userItem(`question-${i + 1}`, turn.question), agentItem(`answer-${i + 1}`, turn.answer)]),
      ),
    ],
  })
}

import { DEMO_CONVERSATION, DEMO_DELTA_MS, DEMO_TITLES, demoReply } from '../provider/demoLibrary'
import { makeFakeClaude, stubSession, transcriptAgent, transcriptUser, type FakeClaude } from './FakeClaude'

/** The Claude side of `HIDEGPT_FAKE=1`: the same fictional library over the in-process SDK. */
export function makeDemoClaude(): FakeClaude {
  const now = Date.now()
  const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  return makeFakeClaude({
    sessions: DEMO_TITLES.map((title, i) => stubSession(id(i), title, '/tmp/course', now - i * 86_400_000)),
    transcripts: {
      [id(0)]: DEMO_CONVERSATION.flatMap((turn, i) => [
        transcriptUser(id(0), `demo-u${i}`, turn.question),
        transcriptAgent(id(0), `demo-a${i}`, turn.answer),
      ]),
    },
    reply: demoReply,
    deltaDelayMs: DEMO_DELTA_MS,
  })
}

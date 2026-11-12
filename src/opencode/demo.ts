import { DEMO_CONVERSATION, DEMO_DELTA_MS, DEMO_TITLES, demoReply } from '../provider/demoLibrary'
import { agentMessage, makeFakeOpenCode, stubSession, userMessage, type FakeOpenCode } from './FakeOpenCode'

/** The OpenCode side of `HIDEGPT_FAKE=1`: the same fictional library over the in-process server. */
export function makeDemoOpenCode(): FakeOpenCode {
  const now = Date.now()
  const sessions = DEMO_TITLES.map((title, i) => stubSession(`ses_demo${i}`, title, i % 2 ? '/tmp/workshop' : '/tmp/course', now - i * 86_400_000))
  return makeFakeOpenCode({
    sessions,
    messages: {
      ses_demo0: DEMO_CONVERSATION.flatMap((turn, i) => [
        userMessage('ses_demo0', `msg_demo${i}u`, turn.question),
        agentMessage('ses_demo0', `msg_demo${i}a`, turn.answer, `msg_demo${i}u`),
      ]),
    },
    reply: demoReply,
    deltaDelayMs: DEMO_DELTA_MS,
    // The real server's heartbeat keeps the adapter's stall watchdog quiet.
    heartbeatMs: 10_000,
  })
}

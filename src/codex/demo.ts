import { createFakeTransport, stubThread, stubTurn } from './fake'

/** Representative, fictional content for visual checks; never uses personal threads. */
export function createDemoTransport() {
  const now = Math.floor(Date.now() / 1000)
  const titles = [
    'Lecture notes — Week 3',
    'Workshop outline',
    'Reading response',
    'A question of belonging',
    'Observations & findings',
    'Ideas for the next chapter',
  ]
  const preview =
    'Ideas from the discussion\n\nUnderstanding begins with paying attention to what is already in front of us. A useful question connects an abstract idea to a concrete experience.\n\nKey points\n• Describe the situation in your own words.\n• Identify what matters and why.\n• Connect the reading to an example.\n\nQuestions to revisit\nWhat changed in the way you understood the topic? Which example best explains the main idea?'
  const threads = titles.map((title, i) => ({
    ...stubThread(`demo-${i}`, preview, title, i === 0 || i === 2 ? 'course' : i === 1 ? 'workshop' : null),
    cwd: '/tmp',
    updatedAt: now - i * 86400,
    recencyAt: now - i * 86400,
  }))
  return createFakeTransport({
    threads,
    projects: [
      {
        id: 'course',
        name: 'Course notes',
        roots: [{ path: '/tmp/course' }],
        metadata: {},
        position: 0,
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
      },
      {
        id: 'workshop',
        name: 'Writing workshop',
        roots: [{ path: '/tmp/workshop' }],
        metadata: {},
        position: 1,
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
      },
      {
        id: 'reading',
        name: 'Reading journal',
        roots: [{ path: '/tmp/reading' }],
        metadata: {},
        position: 2,
        createdAt: now,
        updatedAt: now,
        recencyAt: null,
      },
    ],
    turns: [
      stubTurn('demo-turn', [
        {
          type: 'userMessage',
          id: 'question-1',
          clientId: null,
          content: [{ type: 'text', text: 'How do we move from an idea to understanding?', text_elements: [] }],
        },
        {
          type: 'agentMessage',
          id: 'answer-1',
          text: '**Understanding starts with attention.** Before we explain an idea, we need to notice the situation it comes from: the people involved, the choices available, and what is at stake.\n\nA definition gives us a starting point. An example lets us see how the idea works in practice. The connection between the two is where understanding develops.\n\n### Three ways to work with a reading\n\n1. **Describe it simply.** Explain the main idea in familiar words, while keeping the author’s essential terms.\n2. **Find a concrete example.** Connect the idea to something you have experienced or observed.\n3. **Ask what follows.** Consider how this changes a decision, a relationship, or a way of seeing the world.\n\nThe goal is to build a connected argument: each point should help explain the next one.',
          phase: null,
          delivery: null,
          memoryCitation: null,
          questions: null,
        },
        {
          type: 'userMessage',
          id: 'question-2',
          clientId: null,
          content: [{ type: 'text', text: 'What makes a useful example?', text_elements: [] }],
        },
        {
          type: 'agentMessage',
          id: 'answer-2',
          text: 'A useful example is specific enough to picture and simple enough to explain. It makes the important relationship visible.\n\nFor instance, a group project can show the difference between dividing tasks and sharing responsibility. Both involve working together, but shared responsibility also means caring about the result as a whole.\n\n**Question to revisit:** Which detail in your example helps explain the concept most clearly?',
          phase: null,
          delivery: null,
          memoryCitation: null,
          questions: null,
        },
      ]),
    ],
  })
}

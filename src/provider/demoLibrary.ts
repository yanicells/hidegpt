/**
 * The fictional course library every provider shows under `HIDEGPT_FAKE=1`
 * (screenshots, the bench, demos). Never personal documents.
 */

export const DEMO_TITLES = [
  'Lecture notes — Week 3',
  'Workshop outline',
  'Reading response',
  'A question of belonging',
  'Observations & findings',
  'Ideas for the next chapter',
] as const

export const DEMO_PREVIEW =
  'Ideas from the discussion\n\nUnderstanding begins with paying attention to what is already in front of us. A useful question connects an abstract idea to a concrete experience.\n\nKey points\n• Describe the situation in your own words.\n• Identify what matters and why.\n• Connect the reading to an example.\n\nQuestions to revisit\nWhat changed in the way you understood the topic? Which example best explains the main idea?'

/** The conversation in the first document. */
export const DEMO_CONVERSATION: ReadonlyArray<{ readonly question: string; readonly answer: string }> = [
  {
    question: 'How do we move from an idea to understanding?',
    answer:
      '**Understanding starts with attention.** Before we explain an idea, we need to notice the situation it comes from: the people involved, the choices available, and what is at stake.\n\nA definition gives us a starting point. An example lets us see how the idea works in practice. The connection between the two is where understanding develops.\n\n### Three ways to work with a reading\n\n1. **Describe it simply.** Explain the main idea in familiar words, while keeping the author’s essential terms.\n2. **Find a concrete example.** Connect the idea to something you have experienced or observed.\n3. **Ask what follows.** Consider how this changes a decision, a relationship, or a way of seeing the world.\n\nThe goal is to build a connected argument: each point should help explain the next one.',
  },
  {
    question: 'What makes a useful example?',
    answer:
      'A useful example is specific enough to picture and simple enough to explain. It makes the important relationship visible.\n\nFor instance, a group project can show the difference between dividing tasks and sharing responsibility. Both involve working together, but shared responsibility also means caring about the result as a whole.\n\n**Question to revisit:** Which detail in your example helps explain the concept most clearly?',
  },
]

/** What a demo document answers to a new question. */
export const demoReply = (text: string) =>
  `**Here is a first draft.** You asked: “${text.slice(0, 80)}”.\n\nA clear answer starts with the main idea, then supports it with one concrete example.\n\n1. State the idea in plain words.\n2. Give an example.\n3. Say why it matters.`

/** Streamed words arrive this far apart, like a real model. */
export const DEMO_DELTA_MS = 30

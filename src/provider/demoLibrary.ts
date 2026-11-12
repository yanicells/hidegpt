/**
 * The fictional course library every provider shows under `HIDEGPT_FAKE=1`
 * (screenshots, the bench, demos). Never personal documents.
 */

/**
 * The documents, newest first. Each preview is the document's opening text:
 * Home cards show its first line as the page's Heading 1 and the rest as its
 * body, so every thumbnail reads differently. The first is DEMO_CONVERSATION's.
 */
export const DEMO_DOCUMENTS: ReadonlyArray<{ readonly title: string; readonly preview: string }> = [
  {
    title: 'Lecture notes — Week 3',
    preview:
      'How do we move from an idea to understanding?\n\nUnderstanding starts with attention. Before we explain an idea, we need to notice the situation it comes from: the people involved, the choices available, and what is at stake.\n\nThree ways to work with a reading\n1. Describe it simply.\n2. Find a concrete example.\n3. Ask what follows.',
  },
  {
    title: 'Workshop outline',
    preview:
      'Plan for Thursday’s workshop\n\nOpen with ten minutes of free writing on the prompt, then move into pairs for feedback.\n\nAgenda\n• Warm-up: one sentence that surprised you this week\n• Peer review in pairs, 20 minutes\n• Whole-group discussion of openings\n• Wrap-up and next steps',
  },
  {
    title: 'Reading response',
    preview:
      'Response to chapter four\n\nThe author argues that habits are shaped more by our surroundings than by willpower. I found the hospital example convincing, though it leaves out what happens when the setting changes.\n\nWhat I would ask in class: does the argument hold for habits we choose on purpose?',
  },
  {
    title: 'A question of belonging',
    preview:
      'What does it mean to belong somewhere?\n\nBelonging seems to grow from small, repeated moments: being expected, being missed, being asked for help. A place becomes ours when someone notices we are gone.\n\nDraft thesis: belonging is less a feeling we have than a role others give us.',
  },
  {
    title: 'Observations & findings',
    preview:
      'Field notes from the community garden\n\nSaturday, 9:00–11:30. Fourteen volunteers, most of them returning. Work split into weeding, watering and building two new beds.\n\nFindings\n• Newcomers stayed longer when paired with a regular\n• The tool shed doubles as a meeting point\n• Conversations started over shared tasks',
  },
  {
    title: 'Ideas for the next chapter',
    preview:
      'Where the story could go next\n\nMara leaves the city at the end of chapter six, but the reader still does not know why she kept the letters.\n\nOptions\n• Open with her brother finding the box\n• Jump ahead a year and work backwards\n• Tell the next chapter from the neighbour’s point of view',
  },
]

export const DEMO_TITLES = DEMO_DOCUMENTS.map((doc) => doc.title)

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

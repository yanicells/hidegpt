import type { Block, SnapshotDiff } from '../../shared/contracts'

/** The page content of the Google Docs reference captures (`references/google-docs/`), as blocks. */
export const referenceDocument: SnapshotDiff = {
  fields: { streaming: false, title: 'THEO 12' },
  blocks: {
    length: 2,
    set: [
      [0, { kind: 'user', id: 'ref-q', text: 'How does photosynthesis turn light into sugar?' }],
      [
        1,
        {
          kind: 'agent',
          id: 'ref-a',
          text: [
            'Photosynthesis happens in two linked stages inside the chloroplast. The light-dependent reactions capture energy from sunlight and store it in ATP and NADPH, while the Calvin cycle uses that stored energy to fix carbon dioxide into sugar.',
            '## Light-dependent reactions',
            '- Take place in the thylakoid membranes\n- Split water molecules and release oxygen as a by-product\n- Produce ATP and NADPH for the next stage',
            '## The Calvin cycle',
            '1. Carbon fixation: RuBisCO attaches CO2 to RuBP\n2. Reduction: ATP and NADPH convert the product into G3P\n3. Regeneration: most G3P is recycled to rebuild RuBP',
            'In short, light energy becomes chemical energy, and chemical energy builds glucose. Every six turns of the cycle produce one glucose molecule, which the plant can burn for energy or store as starch.',
          ].join('\n\n'),
        },
      ],
    ],
  },
}

export const question: Block = { kind: 'user', id: 'shot-question', text: 'How would we check the worked examples?' }

/** A reply caught mid-stream, with a code block. */
export const reply: Block = {
  kind: 'agent',
  id: 'shot-reply',
  text: 'Run each example as a short script and compare its output with the expected value:\n\n```\nfor example in examples/*.txt; do\n  check-example "$example" --expect "${example%.txt}.out"\ndone\n```\n\nIf an example',
}

/** The same reply, finished, ahead of a pending suggestion. */
export const finishedReply: Block = { ...reply, text: reply.text.replace(/\n\nIf an example$/, '') }

export const suggestion: Block = {
  kind: 'approval',
  id: 'shot-approval',
  suggestion: 'add',
  title: 'Run command?',
  body: 'check-example examples/week-3.txt',
  fields: [],
  questions: [],
  resolved: null,
}

export const questionSuggestion: Block = {
  kind: 'approval',
  id: 'shot-ask',
  suggestion: 'question',
  title: 'Which section should come first?',
  body: 'Pick one so the outline can be reordered.',
  fields: [],
  questions: [
    { id: 'q1', question: 'Which section should come first?', options: ['Definitions', 'Examples'], allowText: true },
  ],
  resolved: null,
}

export const formatSuggestion: Block = {
  kind: 'approval',
  id: 'shot-format',
  suggestion: 'format',
  title: 'Edit notes.md?',
  body: 'notes.md',
  fields: [],
  questions: [],
  resolved: null,
}

export const callout: Block = {
  kind: 'callout',
  id: 'shot-callout',
  title: 'Ran a command',
  body: 'npm test\n\n12 passed',
}

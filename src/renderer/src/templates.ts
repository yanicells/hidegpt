/**
 * Template strip on the Docs home. Each template starts a new document and
 * seeds the composer with a starter question; nothing is sent until you press Enter.
 */
export type Template = {
  id: string
  title: string
  category: string
  /** Text placed in the composer of the new document. Empty for Blank. */
  prompt: string
  /** Mini-page layout drawn in the thumbnail. */
  sketch: 'blank' | 'essay' | 'notes' | 'guide' | 'report' | 'letter'
}

export const TEMPLATES: Template[] = [
  { id: 'blank', title: 'Blank document', category: '', prompt: '', sketch: 'blank' },
  {
    id: 'essay',
    title: 'Essay',
    category: 'Outline first',
    prompt: 'Outline a five-paragraph essay on ',
    sketch: 'essay',
  },
  {
    id: 'notes',
    title: 'Lecture notes',
    category: 'Clean up',
    prompt: 'Rewrite these lecture notes into clear headings and bullet points:\n',
    sketch: 'notes',
  },
  {
    id: 'guide',
    title: 'Study guide',
    category: 'Exam prep',
    prompt: 'Make a study guide with key terms and practice questions for ',
    sketch: 'guide',
  },
  {
    id: 'report',
    title: 'Lab report',
    category: 'Science',
    prompt: 'Draft a lab report with methods, results, and discussion. Here is my data:\n',
    sketch: 'report',
  },
  {
    id: 'letter',
    title: 'Letter',
    category: 'Formal',
    prompt: 'Write a formal letter to ',
    sketch: 'letter',
  },
]

let pendingDraft = ''

/** Called when a template is chosen; the next composer to mount picks this up once. */
export function setPendingDraft(text: string): void {
  pendingDraft = text
}

export function takePendingDraft(): string {
  const text = pendingDraft
  pendingDraft = ''
  return text
}

/** @vitest-environment jsdom */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import { emptySnapshot, type ApprovalBlock, type Block } from '../../shared/model'
import { stealthViolations } from '../../shared/stealth'
import { BlockView } from './components/document/BlockView'
import { modeLabel } from './components/document/toolbarMenus'
import { Banners } from './components/layout/Banners'

/**
 * The renderer's stealth gate, in two halves:
 *
 * - Rendered: the renderer's own wording for blocks and banners (verbs,
 *   button labels, placeholders, banner sentences). The content here is
 *   neutral, so any hit is a word the renderer wrote.
 * - Source: every piece of text the renderer's source writes for a person to
 *   read (JSX text, and the string values of attributes and properties that
 *   become labels or tooltips), so a screen no render test reaches is covered
 *   too. No allow-list: a label that needs a banned word needs other wording.
 *
 * `present.test.ts` covers what main writes, and `stealthFilter.ts` what
 * providers pass through.
 */

afterEach(cleanup)

/** Visible text plus the attributes a screen reader or a hover shows. */
function wording(): string {
  const attributes = Array.from(document.querySelectorAll('[aria-label], [placeholder], [title], [alt]')).flatMap(
    (node) => ['aria-label', 'placeholder', 'title', 'alt'].map((name) => node.getAttribute(name) ?? ''),
  )
  return [document.body.textContent ?? '', ...attributes].join('\n')
}

const approval = (suggestion: ApprovalBlock['suggestion'], pending = false): ApprovalBlock => ({
  kind: 'approval',
  id: `ap_${suggestion}`,
  suggestion,
  title: 'Apply changes?',
  body: 'notes.md',
  fields: [{ id: 'f1', label: 'Folder' }],
  questions: [
    { id: 'q1', question: 'Which file?', options: ['notes.md', 'todo.md'], allowText: true },
    { id: 'q2', question: 'Why?', options: [], allowText: true },
  ],
  resolved: null,
  pending,
})

describe('renderer wording', () => {
  it('suggestion cards and callouts say nothing a model would', () => {
    const blocks: Block[] = [
      { kind: 'callout', id: 'c1', title: 'Ran a command', body: 'ls' },
      approval('add'),
      approval('replace'),
      approval('format', true),
      approval('question'),
    ]
    render(
      <>
        {blocks.map((block) => (
          <BlockView key={block.id} block={block} streaming />
        ))}
      </>,
    )
    expect(screen.getAllByLabelText('Accept suggestion')).toHaveLength(4)
    expect(stealthViolations(wording())).toEqual([])
  })

  it('sign-in and error banners say nothing a model would', () => {
    const snap = {
      ...emptySnapshot('/tmp', 'codex'),
      status: 'ready' as const,
      requiresAuth: true,
      loginUrl: 'https://auth.example/login',
      error: 'Docs lost its connection. Try again in a moment.',
    }
    render(<Banners snap={snap} />)
    fireEvent.click(screen.getByText('Details'))
    expect(screen.getByTestId('auth-banner')).toBeTruthy()
    expect(screen.getByTestId('login-url')).toBeTruthy()
    expect(stealthViolations(wording())).toEqual([])
  })
})

// ---- source -------------------------------------------------------------------------

/** Attributes and object properties whose string value a person reads. */
const VISIBLE = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'tip',
  'description',
  'tooltip',
  'heading',
  'text',
])

type Found = { readonly file: string; readonly line: number; readonly text: string }

/** A file's `const NAME = 'text'` values, so `{NAME}` in JSX is read as its text. */
type Constants = ReadonlyMap<string, ts.Node>

/**
 * The strings an expression can evaluate to, where it is a value and not a
 * key: literals, a constant declared in the same file, both sides of `+`,
 * both branches of `a ? b : c`, and the right side of `&&`, `||` and `??`.
 * A comparison such as `kind === 'agent'` is not visible text.
 */
function valueStrings(node: ts.Node, constants: Constants): ts.Node[] {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return [node]
  if (ts.isIdentifier(node)) {
    const value = constants.get(node.text)
    return value ? [value] : []
  }
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node) || ts.isAsExpression(node)) {
    return node.expression ? valueStrings(node.expression, constants) : []
  }
  if (ts.isConditionalExpression(node)) {
    return [...valueStrings(node.whenTrue, constants), ...valueStrings(node.whenFalse, constants)]
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return valueStrings(node.right, constants)
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return [...valueStrings(node.left, constants), ...valueStrings(node.right, constants)]
    }
  }
  return []
}

/** The literal text of a string or template (the fixed parts of a template). */
function textOf(node: ts.Node): string {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  if (ts.isJsxText(node)) return node.text
  return ''
}

const nameOf = (name: ts.Node): string =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : ts.isJsxNamespacedName(name) ? '' : name.getText()

/** Every visible string in one source file. */
function visibleStrings(file: string, source: string): Found[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const constants = new Map<string, ts.Node>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = node.initializer
      if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) constants.set(node.name.text, value)
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)
  const found: Found[] = []
  const add = (node: ts.Node) => {
    const text = textOf(node).trim()
    if (!text) return
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    found.push({ file, line, text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) add(node)
    else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      valueStrings(node, constants).forEach(add)
    } else if (ts.isJsxAttribute(node) && VISIBLE.has(nameOf(node.name)) && node.initializer) {
      valueStrings(node.initializer, constants).forEach(add)
    } else if (ts.isPropertyAssignment(node) && VISIBLE.has(nameOf(node.name))) {
      valueStrings(node.initializer, constants).forEach(add)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const ROOT = import.meta.dirname

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('renderer source', () => {
  it('names extra modes "Custom N", never by the provider’s mode name', () => {
    expect([0, 1, 2, 3, 4].map(modeLabel)).toEqual(['Editing', 'Suggesting', 'Viewing', 'Custom 1', 'Custom 2'])
  })

  it('finds visible text in JSX, labels and tooltips, but not in comparisons or keys', () => {
    const source = `
      const LABEL = 'Ask Claude'
      const rows = [{ label: 'Bold', id: 'model-row', heading: 'Agent notes' }]
      export const A = ({ kind, name }) => (
        <div aria-label="Ask the assistant" title={kind === 'agent' ? 'Agent mode' : undefined} data-testid="chip-model">
          Hello {kind === 'agent' && 'the model'} {String(kind)} {LABEL}
          <span aria-description={'Made by ' + name + ' bot'} />
        </div>
      )`
    expect(visibleStrings('A.tsx', source).map(({ text }) => text)).toEqual([
      'Bold',
      'Agent notes',
      'Ask the assistant',
      'Agent mode',
      'Hello',
      'the model',
      'Ask Claude',
      'Made by',
      'bot',
    ])
  })

  it('has no banned word in any visible string', () => {
    const files = sourceFiles(ROOT)
    expect(files.length).toBeGreaterThan(20)
    const leaks = files
      .flatMap((file) => visibleStrings(file, readFileSync(file, 'utf8')))
      .filter(({ text }) => stealthViolations(text).length > 0)
      .map(({ file, line, text }) => `${relative(ROOT, file)}:${line}: ${JSON.stringify(text)}`)
    expect(leaks).toEqual([])
  })
})

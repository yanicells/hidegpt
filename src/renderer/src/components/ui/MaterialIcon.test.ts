import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { opticalSize } from './MaterialIcon'
import { SYMBOLS } from './symbols'

const RENDERER = join(import.meta.dirname, '../..')

/**
 * The only non-literal MIcon names, per file: each forwards a prop. The names
 * behind them are read where they are written: any `icon: '...'` property or
 * `icon="..."` attribute (menu items, AccountMenu's rows), and the `name` of the
 * toolbar's glyph components. Any other non-literal name fails until listed here.
 */
const FORWARDERS: Record<string, string[]> = {
  'components/ui/MenuPanel.tsx': ['item.icon'],
  'components/layout/AccountMenu.tsx': ['icon'],
  'components/document/ToolbarTools.tsx': ['name'],
}
const NAME_PROP_COMPONENTS = new Set(['Decor', 'MarkToggle', 'ToolButton'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'symbols.ts' ? [path] : []
  })
}

/**
 * Splits a name expression into the string literals it can evaluate to and the
 * other expressions it reads (`a ? 'x' : b` gives ['x'] and [b]).
 */
function leaves(node: ts.Node): { names: string[]; reads: ts.Node[] } {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { names: [node.text], reads: [] }
  if ((ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) && node.expression) {
    return leaves(node.expression)
  }
  const both = (a: ts.Node, b: ts.Node) => {
    const [x, y] = [leaves(a), leaves(b)]
    return { names: [...x.names, ...y.names], reads: [...x.reads, ...y.reads] }
  }
  if (ts.isConditionalExpression(node)) return both(node.whenTrue, node.whenFalse)
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return both(node.left, node.right)
  }
  return { names: [], reads: [node] }
}

/** Reading another object's `icon` (`mode.icon`) adds no names: every `icon:` property is collected where it is written. */
const readsIconField = (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.name.text === 'icon'

/** Where `MIcon` may appear: a JSX tag, its own definition, or an import under its own name. */
function plainMIconUse(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) {
    return parent.tagName === node
  }
  if (ts.isFunctionDeclaration(parent)) return parent.name === node
  return ts.isImportSpecifier(parent) && !parent.propertyName
}

/**
 * Every Material Symbol the renderer draws, as `name@opsz`, read from the source:
 * each `<MIcon>`'s name and size, plus the names forwarded through props.
 * `unresolved` lists the sites the scan can't evaluate.
 */
function drawnIcons() {
  const drawn = new Set<string>()
  const forwarded = new Set<string>()
  const forwardedSizes = new Set<number>()
  const unresolved: string[] = []

  for (const path of sourceFiles(RENDERER)) {
    const file = relative(RENDERER, path)
    const text = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`

    /** Collects a forwarded name expression: literals, or reads of another `icon` field. */
    const forward = (node: ts.Node, label: string) => {
      const { names, reads } = leaves(node)
      names.forEach((name) => forwarded.add(name))
      if (!reads.every(readsIconField)) unresolved.push(`${where(node)} ${label}`)
    }

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === 'MIcon' && !plainMIconUse(node)) {
        unresolved.push(`${where(node)} MIcon used outside a JSX tag`)
      }
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText(source)
        const attrs = new Map<string, ts.JsxAttribute>()
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr)) attrs.set(attr.name.getText(source), attr)
          else if (tag === 'MIcon') unresolved.push(`${where(attr)} spread props`)
        }
        if (tag === 'MIcon') {
          const size = attrs.get('size')?.initializer
          const sizeValue = size && ts.isJsxExpression(size) ? size.expression : undefined
          let opsz = 20
          if (size) {
            if (sizeValue && ts.isNumericLiteral(sizeValue)) opsz = opticalSize(Number(sizeValue.text))
            else unresolved.push(`${where(node)} size`)
          }
          const name = attrs.get('name')?.initializer
          const { names, reads } = name ? leaves(name) : { names: [], reads: [node] }
          for (const icon of names) drawn.add(`${icon}@${opsz}`)
          for (const read of reads) {
            if (FORWARDERS[file]?.includes(read.getText(source))) forwardedSizes.add(opsz)
            else unresolved.push(`${where(node)} name`)
          }
        } else {
          for (const prop of NAME_PROP_COMPONENTS.has(tag) ? ['icon', 'name'] : ['icon']) {
            const value = attrs.get(prop)?.initializer
            if (!value) continue
            // An element (`icon={<MIcon ... />}`) is scanned as its own MIcon.
            const inner = ts.isJsxExpression(value) ? value.expression : undefined
            if (inner && (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner))) continue
            forward(value, prop)
          }
        }
      } else if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'icon') {
        forward(node.initializer, 'icon')
      } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'icon') {
        unresolved.push(`${where(node)} icon`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  for (const name of forwarded) for (const opsz of forwardedSizes) drawn.add(`${name}@${opsz}`)
  return { drawn: [...drawn].sort(), unresolved }
}

describe('Material Symbols', () => {
  it('ship exactly the icons and optical sizes the renderer draws', () => {
    const { drawn, unresolved } = drawnIcons()
    // A site the scan can't read: use a literal name and size, or list the forwarding expression in FORWARDERS.
    expect(unresolved).toEqual([])
    const shipped = Object.entries(SYMBOLS)
      .flatMap(([name, cuts]) => Object.keys(cuts).map((opsz) => `${name}@${opsz}`))
      .sort()
    // A mismatch: edit OPSZ in scripts/material-symbols.py and regenerate symbols.ts.
    expect(shipped).toEqual(drawn)
  })

  it('draw up to 20px from the 20px cut and larger sizes from the 24px cut', () => {
    expect([14.4, 18, 20, 20.5, 24, 36].map(opticalSize)).toEqual([20, 20, 20, 24, 24, 24])
  })
})

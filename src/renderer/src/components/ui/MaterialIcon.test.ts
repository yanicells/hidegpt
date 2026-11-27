import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { opticalSize } from './MaterialIcon'
import { SYMBOLS } from './symbols'

const RENDERER = join(import.meta.dirname, '../..')

/**
 * The only non-literal MIcon names: per file, the function that passes one of its
 * own parameters to MIcon, and the expression it passes. The names behind them are
 * read where they are written: any `icon: '...'` property or `icon="..."` attribute
 * (menu items, AccountMenu's rows), and a component's forwarded prop on its JSX tag
 * (`<Decor name="..." />`). A branch that forwards a new prop to MIcon adds it here.
 */
const FORWARDERS: Record<string, Record<string, string>> = {
  'components/ui/MenuPanel.tsx': { RowBody: 'item.icon' },
  'components/layout/AccountMenu.tsx': { AccountAction: 'icon' },
  'components/document/ToolbarTools.tsx': { MarkToggle: 'name', Decor: 'name', ToolButton: 'name' },
}

/** Components that forward a prop of their own straight to MIcon, and that prop (Decor: name). */
const FORWARDED_PROPS = new Map(
  Object.values(FORWARDERS).flatMap((functions) =>
    Object.entries(functions).filter(([, expression]) => /^\w+$/.test(expression)),
  ),
)

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

/** Where `MIcon` may appear: a JSX tag, an import under its own name, or its definition in MaterialIcon.tsx. */
function plainMIconUse(node: ts.Identifier, file: string): boolean {
  const parent = node.parent
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) {
    return parent.tagName === node
  }
  if (ts.isFunctionDeclaration(parent)) return parent.name === node && file === 'components/ui/MaterialIcon.tsx'
  return ts.isImportSpecifier(parent) && !parent.propertyName
}

/** Whether `name` is declared in `fn` only once, by one of its parameters (so it can't be a local stand-in). */
function boundOnlyByParameter(fn: ts.FunctionDeclaration, name: string): boolean {
  const declarations: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  const [only] = declarations
  return declarations.length === 1 && fn.parameters.some((param) => param.pos <= only.pos && only.end <= param.end)
}

/**
 * Whether a non-literal MIcon name is a listed forward: the exact expression
 * FORWARDERS gives for its enclosing function, rooted in that function's parameter.
 */
function isForward(read: ts.Node, file: string, source: ts.SourceFile): boolean {
  let fn: ts.Node | undefined = read.parent
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.name) return false
  if (FORWARDERS[file]?.[fn.name.text] !== read.getText(source)) return false
  let root = read
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  return ts.isIdentifier(root) && boundOnlyByParameter(fn, root.text)
}

/**
 * Every Material Symbol the renderer draws, as `name@opsz`, read from the source:
 * each `<MIcon>`'s name and size, plus the names forwarded through props.
 * `unresolved` lists the sites the scan can't evaluate. It is a syntactic scan, not
 * a type check: it trusts that every `icon` field is written in the renderer (none
 * exists outside it), and a deliberately computed lookup (`UI['MI' + 'con']`) gets
 * past it; MIcon's fallback then draws the other cut rather than nothing.
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
      if (ts.isIdentifier(node) && node.text === 'MIcon' && !plainMIconUse(node, file)) {
        unresolved.push(`${where(node)} MIcon used outside a JSX tag`)
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'MIcon') {
        unresolved.push(`${where(node)} MIcon looked up by name`)
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
            if (isForward(read, file, source)) forwardedSizes.add(opsz)
            else unresolved.push(`${where(node)} name`)
          }
        } else {
          const own = FORWARDED_PROPS.get(tag)
          for (const prop of own && own !== 'icon' ? ['icon', own] : ['icon']) {
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

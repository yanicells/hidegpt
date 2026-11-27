import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { opticalSize } from './MaterialIcon'
import { SYMBOLS } from './symbols'

const RENDERER = join(import.meta.dirname, '../..')

/**
 * Files whose MIcon takes its name from a prop, and where those names are written:
 * any `icon: '...'` property or `icon="..."` attribute (menu items, AccountMenu's
 * rows) and the `name` of the toolbar's glyph components. A new forwarding site
 * fails the test until it is listed here.
 */
const FORWARDERS = new Set([
  'components/ui/MenuPanel.tsx',
  'components/layout/AccountMenu.tsx',
  'components/document/ToolbarTools.tsx',
])
const NAME_PROP_COMPONENTS = new Set(['Decor', 'MarkToggle', 'ToolButton'])

/** MIcon sites whose `size` is a variable: DocMenu's `size`, which both callers pass as 24. */
const VARIABLE_SIZES: Record<string, number[]> = { 'components/home/DocCard.tsx': [24] }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'symbols.ts' ? [path] : []
  })
}

/**
 * The icon names an expression can evaluate to, or null when the scan can't tell.
 * Reading another object's `icon` (`mode.icon`) adds nothing: every `icon:`
 * property is collected where it is written.
 */
function literals(node: ts.Node | undefined, onIconRead?: () => void): string[] | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) return literals(node.expression, onIconRead)
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'icon') {
    onIconRead?.()
    return []
  }
  const either = (a: ts.Node, b: ts.Node) => {
    const [x, y] = [literals(a, onIconRead), literals(b, onIconRead)]
    return x && y ? [...x, ...y] : null
  }
  if (ts.isConditionalExpression(node)) return either(node.whenTrue, node.whenFalse)
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return either(node.left, node.right)
  }
  return null
}

/**
 * Every Material Symbol the renderer draws, as `name@opsz`, read from the source:
 * each `<MIcon>`'s name and size, plus the names forwarded through props.
 * `unresolved` lists sites the scan can't evaluate.
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

    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText(source)
        const attrs = new Map<string, ts.JsxAttribute>()
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr)) attrs.set(attr.name.getText(source), attr)
          else if (tag === 'MIcon') unresolved.push(`${where(attr)} spread props`)
        }
        if (tag === 'MIcon') {
          const size = attrs.get('size')?.initializer
          const sizeLiteral = size && ts.isJsxExpression(size) ? size.expression : undefined
          const sizes = !size
            ? [20]
            : sizeLiteral && ts.isNumericLiteral(sizeLiteral)
              ? [Number(sizeLiteral.text)]
              : VARIABLE_SIZES[file]
          if (!sizes) unresolved.push(`${where(node)} size`)
          let readsIcon = false
          const names = literals(attrs.get('name')?.initializer, () => (readsIcon = true))
          for (const name of names ?? []) for (const s of sizes ?? []) drawn.add(`${name}@${opticalSize(s)}`)
          if (!names || readsIcon) {
            if (FORWARDERS.has(file)) for (const s of sizes ?? []) forwardedSizes.add(opticalSize(s))
            else unresolved.push(`${where(node)} name`)
          }
        } else {
          const forwarding = [attrs.get('icon'), NAME_PROP_COMPONENTS.has(tag) ? attrs.get('name') : undefined]
          for (const attr of forwarding) {
            if (!attr) continue
            const names = literals(attr.initializer)
            const value =
              attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined
            // An element (`icon={<MIcon ... />}`) is scanned as its own MIcon.
            if (names) names.forEach((name) => forwarded.add(name))
            else if (!value || !(ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value))) {
              unresolved.push(`${where(attr)} ${attr.name.getText(source)}`)
            }
          }
        }
      } else if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText(source) === 'icon'
      ) {
        const names = ts.isPropertyAssignment(node) ? literals(node.initializer) : null
        if (names) names.forEach((name) => forwarded.add(name))
        else unresolved.push(`${where(node)} icon`)
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
    // A site the scan can't read: make its names literal, or list it in FORWARDERS / VARIABLE_SIZES.
    expect(unresolved).toEqual([])
    const shipped = Object.entries(SYMBOLS)
      .flatMap(([name, cuts]) => Object.keys(cuts).map((opsz) => `${name}@${opsz}`))
      .sort()
    // A mismatch: edit the lists in scripts/material-symbols.py and regenerate symbols.ts.
    expect(shipped).toEqual(drawn)
  })

  it('draw up to 20px from the 20px cut and larger sizes from the 24px cut', () => {
    expect([14.4, 18, 20, 20.5, 24, 36].map(opticalSize)).toEqual([20, 20, 20, 24, 24, 24])
  })
})

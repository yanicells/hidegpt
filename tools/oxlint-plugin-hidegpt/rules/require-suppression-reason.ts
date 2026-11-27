// Adapted from T3 Code (oxlint-plugin-t3code/rules/require-suppression-reason.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type Context = Parameters<NonNullable<Rule['create']>>[0]
type Comment = ReturnType<Context['sourceCode']['getAllComments']>[number]

const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)|@effect-diagnostics)/u
const TS_DIRECTIVE_PATTERN = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su
const EMPTY_COMMENT_PATTERN = /^[\s*]*$/u

/**
 * Every lint or type-checker suppression says why: `-- reason` after a lint
 * directive, text after a `@ts-` directive, or a comment on the line above
 * (stacked directives and empty comment lines between are skipped).
 */
const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require every lint or type-checker suppression to say why.' },
  },
  create(context) {
    const { sourceCode } = context
    return {
      Program() {
        const comments = sourceCode.getAllComments()
        // Comments alone on their line, keyed by the line they end on.
        const ownLineCommentsByEndLine = new Map<number, Comment>()
        for (const comment of comments) {
          const { line, column } = comment.loc.start
          if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') {
            ownLineCommentsByEndLine.set(comment.loc.end.line, comment)
          }
        }

        const explainedAbove = (directive: Comment) => {
          let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1)
          while (above && (DIRECTIVE_PATTERN.test(above.value) || EMPTY_COMMENT_PATTERN.test(above.value))) {
            above = ownLineCommentsByEndLine.get(above.loc.start.line - 1)
          }
          return above !== undefined
        }

        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === 'enable' || directive.justification?.trim()) continue
          if (explainedAbove(directive.node)) continue
          context.report({
            loc: directive.node.loc,
            message: 'Say why: end the directive with `-- reason` or put a comment on the line above.',
          })
        }

        for (const comment of comments) {
          const after = TS_DIRECTIVE_PATTERN.exec(comment.value)?.[1]
          if (after === undefined || after.replace(/^[\s:-]+/u, '').trim()) continue
          if (explainedAbove(comment)) continue
          context.report({
            loc: comment.loc,
            message: 'Say why: write the reason after the directive or in a comment on the line above.',
          })
        }
      },
    }
  },
} satisfies Rule

export default rule

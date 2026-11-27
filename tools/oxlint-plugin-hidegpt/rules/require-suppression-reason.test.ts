import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import rule from './require-suppression-reason.ts'

RuleTester.describe = describe
RuleTester.it = it

// T3 Code's cases (oxlint-plugin-t3code/rules/require-suppression-reason.test.ts at 5c6f2f12).
const tester = new RuleTester({ languageOptions: { sourceType: 'module', parserOptions: { lang: 'tsx' } } })

tester.run('hidegpt/require-suppression-reason', rule, {
  valid: [
    // A `-- reason`.
    `// oxlint-disable-next-line no-control-regex -- ANSI sequences start with ESC.
const ansi = /\\x1b\\[/
/* eslint-disable no-console -- this script reports to the terminal */`,
    // Explained by the comment above.
    `// Positions are stable for a given string.
// oxlint-disable-next-line react/no-array-index-key
const items = ['a'].map((item, index) => <li key={index}>{item}</li>)`,
    // Stacked directives under one explanation.
    `// The fixture is invalid on purpose.
// @ts-expect-error
// oxlint-disable-next-line no-unused-vars
const value: number = 'text'`,
    // A TypeScript directive followed by its reason.
    `// @ts-expect-error the fixture passes a string on purpose
const count: number = 'text'`,
    // In a JSX comment, with a reason.
    `const el = <div>{/* oxlint-disable-next-line react/no-danger -- sanitized above */}</div>`,
    // An empty comment line between the reason and the directive.
    `// Positions are stable for a given string.
//
// oxlint-disable-next-line react/no-array-index-key
const items = ['a'].map((item, index) => <li key={index}>{item}</li>)`,
    // Enable directives need no reason.
    `/* oxlint-enable no-console */`,
  ],
  invalid: [
    {
      code: `// oxlint-disable-next-line no-control-regex
const ansi = /\\x1b\\[/`,
      errors: [{ message: /end the directive with `-- reason`/ }],
    },
    {
      // File-level.
      code: `/* oxlint-disable eslint/no-useless-escape */`,
      errors: [{ message: /end the directive with `-- reason`/ }],
    },
    {
      code: `// @ts-expect-error
const count: number = 'text'`,
      errors: [{ message: /write the reason after the directive/ }],
    },
    {
      // A blank line breaks the link to the comment above.
      code: `// Positions are stable for a given string.

// oxlint-disable-next-line react/no-array-index-key
const items = ['a'].map((item, index) => <li key={index}>{item}</li>)`,
      errors: [{ message: /end the directive with `-- reason`/ }],
    },
    {
      // Only empty comments above.
      code: `//
/* */
// oxlint-disable-next-line react/no-array-index-key
const items = ['a'].map((item, index) => <li key={index}>{item}</li>)`,
      errors: [{ message: /end the directive with `-- reason`/ }],
    },
    {
      // A trailing comment on the code line above is not an explanation.
      code: `const first = 1 // the first value
const second = 2 // oxlint-disable-line no-unused-vars`,
      errors: [{ message: /end the directive with `-- reason`/ }],
    },
  ],
})

// Pre-commit checks on staged files, after T3 Code's `staged` config (vite.config.ts).
// Formatting is not run here yet: see the `fmt` script.
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}':
    'oxlint --deny-warnings --report-unused-disable-directives --no-error-on-unmatched-pattern',
  // knip checks the whole repo, so it takes no file list. Any code or manifest change can leave
  // a file, export, or dependency unused.
  '{*.{js,jsx,ts,tsx,mjs,cjs,mts,cts},package.json,knip.jsonc}': () => 'pnpm knip',
}

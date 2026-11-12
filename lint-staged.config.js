// Pre-commit checks on staged files, after T3 Code's `staged` config (vite.config.ts).
// Same flags as `pnpm lint`; the extra one lets a commit of only ignored files through.
// knip checks the whole repo, untracked files included, so it runs in `pnpm check` and CI
// rather than here. Formatting is not run here yet: see the `fmt` script.
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': 'oxlint --deny-warnings --no-error-on-unmatched-pattern',
}

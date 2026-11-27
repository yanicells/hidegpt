// Pre-commit checks on staged files, after T3 Code's `staged` config (vite.config.ts):
// in order, so lint reads the formatted file. oxlint takes the same flags as `pnpm lint`
// and skips files it does not lint; the extra flag on each lets a commit of only
// ignored files through. knip checks the whole repo, untracked files included, so it
// runs in `pnpm check` and CI rather than here.
export default {
  '*': ['oxfmt --no-error-on-unmatched-pattern', 'oxlint --deny-warnings --no-error-on-unmatched-pattern'],
}

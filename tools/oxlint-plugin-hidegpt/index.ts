// Adapted from T3 Code (oxlint-plugin-t3code/index.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import noUnobservedEffect from './rules/no-unobserved-effect.ts'

/** HideGPT's own lint rules, loaded by .oxlintrc.json as a JS plugin (as T3 Code loads its plugin). */
export default {
  meta: { name: 'hidegpt' },
  rules: { 'no-unobserved-effect': noUnobservedEffect },
}

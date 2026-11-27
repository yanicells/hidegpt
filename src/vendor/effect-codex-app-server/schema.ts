// Vendored from T3 Code (https://github.com/pingdotgg/t3code), packages/effect-codex-app-server
// at commit 8a14762c. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
// HideGPT changes are marked "HideGPT:".
export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";
export * from "./_generated/namespaces.gen.ts";

// Mirrors codex_protocol::protocol::MAX_THREAD_GOAL_OBJECTIVE_CHARS, which the
// generated schema does not carry. Codex counts Unicode scalar values (Rust
// `chars()`), not UTF-16 code units.
export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4_000;

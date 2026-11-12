/**
 * The stealth gate: words that must never appear in text Docs itself puts on
 * the page, because they would make the page read as an AI tool. Tests run
 * every string `present.ts` owns (and the renderer's own block and banner
 * wording) through it, and `present.ts` uses it at runtime to drop a
 * provider-written title that would leak.
 *
 * Yani owns these lists; add a word here and every gate picks it up.
 */
export const BANNED_WORDS: ReadonlyArray<string> = [
  'ai',
  'assistant',
  'agent',
  'model',
  'prompt',
  'llm',
  'token',
  'claude',
  'codex',
  'opencode',
  'chatgpt',
  'anthropic',
  'openai',
  'gpt',
  'copilot',
  'bot',
]

/**
 * Developer words: none names an AI, but each reads as a tool's internals, not a
 * document editor ("Using mcp__github__create_issue", "Spawned a subagent").
 */
export const PROSE_WORDS: ReadonlyArray<string> = ['hidegpt', 'mcp', 'sdk', 'cli', 'subagent', 'provider']

const BANNED = new Set([...BANNED_WORDS, ...PROSE_WORDS])

/** A run of letters split where its case changes: "ChatGPTPlus" is "Chat", "GPT", "Plus". */
const CASE_PARTS = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+/gu
/** A capital run right before lower case, read as a word of its own: "AIsearch", "myGPTs". */
const CAPITAL_RUNS = /\p{Lu}{2,}(?=\p{Ll})/gu

/** `word` lowercased, if it (or it less a plural "s") is banned. */
function banned(word: string): string | null {
  const lower = word.toLowerCase()
  if (BANNED.has(lower)) return lower
  return lower.endsWith('s') && BANNED.has(lower.slice(0, -1)) ? lower.slice(0, -1) : null
}

/**
 * The banned words in `text`, lowercased, in order of appearance; empty when it is clean.
 * Case-insensitive and on whole words, where a word is a run of letters, so "_", "-" and
 * digits split words ("claude_ai", "gpt5", "GPT-4o"). A run that is not banned whole is
 * also checked by its case parts ("OpenAI", "ChatGPTPlus"), so "said" and "maintain" pass
 * but "OpenCode" and "useMcp" do not. A capital run before lower case is checked whole
 * too ("AIsearch", "myGPTs"), while an all-caps word stays one word ("AIRTABLE", "GMAIL").
 * A plural "s" counts too ("agents", "models"). The text is NFKC-normalized and stripped of
 * invisible format characters first, so fullwidth letters and soft hyphens hide nothing.
 */
export function stealthViolations(text: string): string[] {
  const visible = text.normalize('NFKC').replace(/\p{Cf}/gu, '')
  return Array.from(visible.matchAll(/\p{L}+/gu), ([run]) => {
    const whole = banned(run)
    if (whole) return [whole]
    const parts = Array.from(run.matchAll(CASE_PARTS), ([part]) => banned(part)).filter((word) => word !== null)
    const capitals = Array.from(run.matchAll(CAPITAL_RUNS), ([part]) => banned(part)).filter(
      (word): word is string => word !== null && !parts.includes(word),
    )
    return [...parts, ...capitals]
  }).flat()
}

export const isStealthy = (text: string): boolean => stealthViolations(text).length === 0

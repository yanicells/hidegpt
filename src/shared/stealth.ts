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
 * but "OpenCode" and "useMcp" do not. A plural "s" counts too ("agents", "models").
 */
export function stealthViolations(text: string): string[] {
  return Array.from(text.matchAll(/\p{L}+/gu), ([run]) => {
    const whole = banned(run)
    return whole ? [whole] : bannedParts(Array.from(run.matchAll(CASE_PARTS), ([part]) => part))
  }).flat()
}

/**
 * The banned words among a run's case parts. Two adjacent parts are tried joined first, so a
 * banned compound split by its own capitals counts ("useOpenCode" is "use", "OpenCode"), while
 * parts that only join into ordinary words ("OpenCase") stay apart.
 */
function bannedParts(parts: ReadonlyArray<string>): string[] {
  const found: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const joined = index + 1 < parts.length ? banned(parts[index]! + parts[index + 1]!) : null
    const word = joined ?? banned(parts[index]!)
    if (word) found.push(word)
    if (joined) index += 1
  }
  return found
}

export const isStealthy = (text: string): boolean => stealthViolations(text).length === 0

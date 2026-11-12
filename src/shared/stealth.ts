/**
 * The stealth gate: words that must never appear in text Docs itself puts on
 * the page, because they would make the page read as an AI tool. Tests run
 * every string `present.ts` owns (and the renderer's own block and banner
 * wording) through it, and `present.ts` uses it at runtime to drop a
 * provider-written title that would leak.
 *
 * Yani owns this list; add a word here and every gate picks it up.
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
 * Case-insensitive and on whole words, where a word is a run of letters: "AI",
 * "Agent ·", "GPT-5" and "claude_ai" match, "said" and "maintain" do not.
 * A plural "s" counts too ("agents", "models").
 */
const BANNED = new RegExp(`(?<!\\p{L})(${BANNED_WORDS.join('|')})s?(?!\\p{L})`, 'giu')

/** The banned words in `text`, lowercased, in order of appearance; empty when it is clean. */
export function stealthViolations(text: string): string[] {
  return Array.from(text.matchAll(BANNED), (match) => match[1]!.toLowerCase())
}

export const isStealthy = (text: string): boolean => stealthViolations(text).length === 0

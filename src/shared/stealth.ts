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
 * but "OpenCode" and "useMcp" do not. Adjacent case parts are also tried joined (see
 * `bannedParts`), so "useOpenCode" counts. A capital run before lower case is checked whole
 * too ("AIsearch", "myGPTs"), while an all-caps word stays one word ("AIRTABLE", "GMAIL").
 * Within a run, hits keep their order and repeats ("myGPTsAgent" is "gpt", "agent").
 * A plural "s" counts too ("agents", "models"). The text is NFKC-normalized and stripped of
 * invisible format characters first, so fullwidth letters and soft hyphens hide nothing.
 */
export function stealthViolations(text: string): string[] {
  const visible = text.normalize('NFKC').replace(/\p{Cf}/gu, '')
  return Array.from(visible.matchAll(/\p{L}+/gu), ([run]) => {
    const whole = banned(run)
    if (whole) return [whole]
    const parts = bannedParts(Array.from(run.matchAll(CASE_PARTS)))
    // A capital-run hit over a part hit of the same word is that word seen twice ("myGPTs":
    // "GPTs" and "GPT"); over a different word it is a word of its own ("MCPrompt": "mcp", "prompt").
    const capitals = Array.from(run.matchAll(CAPITAL_RUNS), hitOf).filter(
      (hit): hit is Hit =>
        hit !== null && !parts.some((part) => part.word === hit.word && hit.at < part.end && part.at < hit.end),
    )
    return [...parts, ...capitals].sort((a, b) => a.at - b.at).map((hit) => hit.word)
  }).flat()
}

/** A banned word found in a run, with where it starts and ends. */
type Hit = { readonly at: number; readonly end: number; readonly word: string }

const hitOf = (match: RegExpExecArray): Hit | null => {
  const word = banned(match[0])
  return word ? { at: match.index, end: match.index + match[0].length, word } : null
}

/**
 * The banned words among a run's case parts. Two adjacent parts are tried joined first, so a
 * banned compound split by its own capitals counts ("useOpenCode" is "use", "OpenCode"), while
 * parts that only join into ordinary words ("OpenCase") stay apart.
 */
function bannedParts(parts: ReadonlyArray<RegExpExecArray>): Hit[] {
  const found: Hit[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const next = parts[index + 1]
    const joinedWord = next ? banned(part[0] + next[0]) : null
    const hit =
      next && joinedWord ? { at: part.index, end: next.index + next[0].length, word: joinedWord } : hitOf(part)
    if (hit) found.push(hit)
    if (joinedWord) index += 1
  }
  return found
}

export const isStealthy = (text: string): boolean => stealthViolations(text).length === 0

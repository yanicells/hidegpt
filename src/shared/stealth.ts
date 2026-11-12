/**
 * The stealth gate: words that must never appear in text Docs itself puts on
 * the page, because they would make the page read as an AI tool. Tests run
 * every string `present.ts` owns (and the renderer's own wording) through it,
 * `present.ts` uses it at runtime to drop a provider-written title that would
 * leak, and main's last filter (`session/stealthFilter.ts`) rewrites what is
 * left with the helpers below before a snapshot leaves main.
 *
 * Yani owns these lists; add a word here and every gate picks it up.
 */

/**
 * Vendor and product names. One string, so the built renderer carries a single
 * allow-listed literal for the list (see `scripts/stealth-allow.json`).
 */
export const VENDOR_WORDS: ReadonlyArray<string> =
  'claude codex opencode chatgpt anthropic openai gpt copilot hidegpt'.split(' ')

export const BANNED_WORDS: ReadonlyArray<string> = [
  'ai',
  'assistant',
  'agent',
  'model',
  'prompt',
  'llm',
  'token',
  'bot',
  // From the one string above, so the renderer bundle holds no second copy of a vendor name.
  ...VENDOR_WORDS,
]

/**
 * Developer words: none names an AI, but each reads as a tool's internals, not a
 * document editor ("Using mcp__github__create_issue", "Spawned a subagent").
 */
export const PROSE_WORDS: ReadonlyArray<string> = ['mcp', 'sdk', 'cli', 'subagent', 'provider']

/** A word list, and a regex that finds any of its words even inside other words: the cheap first check. */
type Words = { readonly set: ReadonlySet<string>; readonly anywhere: RegExp }
const words = (list: ReadonlyArray<string>): Words => ({
  set: new Set(list),
  anywhere: new RegExp(list.join('|'), 'i'),
})

const BANNED = words([...BANNED_WORDS, ...PROSE_WORDS])
const VENDORS = words(VENDOR_WORDS)

/** A run of letters split where its case changes: "ChatGPTPlus" is "Chat", "GPT", "Plus". */
const CASE_PARTS = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+/gu

/**
 * `text` as a reader sees it: compatibility forms folded (full-width "ＧＰＴ",
 * ligatures) and invisible format characters (zero-width spaces and joiners,
 * soft hyphens) removed, so neither can hide a word from the gate.
 */
const visible = (text: string): string =>
  /[^\x00-\x7f]/.test(text) ? text.normalize('NFKC').replace(/\p{Cf}/gu, '') : text

/** `word` lowercased, if it (or it less a plural "s") is in `words`. */
function listed(word: string, words: ReadonlySet<string>): string | null {
  const lower = word.toLowerCase()
  if (words.has(lower)) return lower
  return lower.endsWith('s') && words.has(lower.slice(0, -1)) ? lower.slice(0, -1) : null
}

function violations(text: string, { set, anywhere }: Words): string[] {
  const clean = visible(text)
  // Most text holds none of the words even inside another word; that answer needs no word split.
  if (!anywhere.test(clean)) return []
  return Array.from(clean.matchAll(/\p{L}+/gu), ([run]) => {
    const whole = listed(run, set)
    if (whole) return [whole]
    return Array.from(run.matchAll(CASE_PARTS), ([part]) => listed(part, set)).filter((word) => word !== null)
  }).flat()
}

/**
 * The banned words in `text`, lowercased, in order of appearance; empty when it is clean.
 * Case-insensitive and on whole words, where a word is a run of letters, so "_", "-" and
 * digits split words ("claude_ai", "gpt5", "GPT-4o"). A run that is not banned whole is
 * also checked by its case parts ("OpenAI", "ChatGPTPlus"), so "said" and "maintain" pass
 * but "OpenCode" and "useMcp" do not. A plural "s" counts too ("agents", "models").
 */
export const stealthViolations = (text: string): string[] => violations(text, BANNED)

export const isStealthy = (text: string): boolean => stealthViolations(text).length === 0

/** The vendor names in `text`, by the same rules as `stealthViolations`. */
export const vendorViolations = (text: string): string[] => violations(text, VENDORS)

const namesVendor = (text: string): boolean => vendorViolations(text).length > 0

// ---- rewriting -----------------------------------------------------------------------
//
// A vendor word can sit inside a larger piece of text ("GPT-5", "ChatGPT's",
// "claude.ai"), so the helpers below replace or drop the whole piece between
// spaces, never only the word: "Chat with GPT-5" must not become "Chat with -5".

/** A product name that is two words, so it goes as one ("Claude Code" must not leave "Code"). */
const PRODUCT = /(?<![\p{L}\p{N}])claude code(?![\p{L}\p{N}])/giu

/** Phrases a sentence uses for whoever answers, read as "Docs". */
const PHRASES = /(?<![\p{L}\p{N}])(?:the model provider|the assistant|claude code)(?![\p{L}\p{N}])/giu

/** Each space-separated piece of `text` that names a vendor, through `replace`; the spaces stay. */
const replacePieces = (text: string, replace: (piece: string) => string): string =>
  text
    .split(/(\s+)/)
    .map((piece) => (piece.trim() && namesVendor(piece) ? replace(piece) : piece))
    .join('')

/**
 * A sentence the page shows, with vendor names and "the assistant" read as
 * "Docs": "Claude is still answering." reads "Docs is still answering."
 * Words that are banned but no vendor's name are left; callers check the
 * result with `isStealthy`.
 */
export function neutralizeSentence(text: string): string {
  const clean = visible(text)
  // `search`, not `test`: a global regex's `test` would carry `lastIndex` into the next call.
  if (!namesVendor(clean) && clean.search(PHRASES) < 0) return text
  return replacePieces(clean.replace(PHRASES, 'Docs'), (piece) => `Docs${/[.,;:!?)]*$/.exec(piece)![0]}`)
}

const NAME_PARTS = /[\s_:./-]+/

/**
 * A provider-given name (a connected app, a skill, a tool) as a Docs label:
 * split into words, banned words dropped, the rest capitalized.
 * `claude-in-chrome` reads "In Chrome", `codex:rescue` "Rescue",
 * `mcp__agent-tools__list_models` "Tools · List" (by its two halves).
 * A leading prefix that names a vendor goes whole (`anthropic-skills:docx`
 * reads "Docx"), and so do numbers left behind by a dropped word
 * (`gpt-5-4-prompting` reads "Prompting"). `fallback` when nothing is left.
 */
export function neutralizeName(name: string, fallback: string): string {
  const clean = visible(name)
  const colon = clean.indexOf(':')
  const rest = colon > 0 && !isStealthy(clean.slice(0, colon)) ? clean.slice(colon + 1) : clean
  const words = rest.split(NAME_PARTS).filter(Boolean)
  const kept = words.filter(isStealthy)
  const label = (kept.length === words.length ? kept : kept.filter((word) => !/^\d+$/.test(word)))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  return label || fallback
}

/**
 * A title (the document's, or one on Home) without the pieces that name a
 * vendor: "Claude Code session" reads "session", "Ask GPT about
 * photosynthesis" reads "Ask about photosynthesis". Other words stay: the
 * person may have written "Essay on AI ethics" themselves. `fallback` when
 * nothing is left; the same string back when nothing named a vendor.
 */
export function stripVendorWords(text: string, fallback: string): string {
  if (!namesVendor(text)) return text
  const stripped = replacePieces(visible(text).replace(PRODUCT, ' '), () => ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:·,-]+|[\s:·,-]+$/g, '')
  return stripped || fallback
}

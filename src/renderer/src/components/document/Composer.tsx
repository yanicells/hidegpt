import { memo, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'

import { IMAGE_MIME_TYPES, isImageMime, type Skill } from '../../../../shared/model'
import { dispatch, showRequestError } from '../../session-bridge'
import { takePendingDraft } from '../../templates'
import { imageSrc } from '../ui/imageSrc'
import { SkillChip, SkillMenu } from './SmartChips'

const IMAGE_INPUT_ID = 'insert-image'

let lastConsumedThreadId: string | null = null
let lastConsumedDraft = ''

function consumeDraftOnce(threadId: string): string {
  if (lastConsumedThreadId === threadId) return lastConsumedDraft
  const text = takePendingDraft()
  lastConsumedThreadId = threadId
  lastConsumedDraft = text
  return text
}

/** Opens the composer's image picker (Insert → Image, toolbar image button). */
export function openImagePicker(): void {
  document.getElementById(IMAGE_INPUT_ID)?.click()
}

/** Focuses the composer and starts an "@" smart-chip insert. */
export function startSmartChip(): void {
  const el = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
  if (!el) return
  el.focus()
  el.setRangeText(el.value && !/\s$/.test(el.value) ? ' @' : '@', el.value.length, el.value.length, 'end')
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * The document's last paragraph. Enter sends; "@" opens the skill menu;
 * pasted, dropped, or inserted images attach to the next question.
 */
export const Composer = memo(function Composer({
  threadId,
  streaming,
  skills,
}: {
  threadId: string
  streaming: boolean
  skills: ReadonlyArray<Skill>
}) {
  const [draft, setDraft] = useState(() => consumeDraftOnce(threadId))
  const [skill, setSkill] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const query = mention?.query.toLowerCase() ?? ''
  const matches = mention ? skills.filter((item) => item.name.toLowerCase().includes(query)).slice(0, 8) : []

  useEffect(() => {
    const el = ref.current
    if (el) {
      // preventScroll: focusing the last paragraph must not yank the view
      // away from the top of an existing document.
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    }
    const timer = setTimeout(() => {
      if (lastConsumedThreadId === threadId) lastConsumedThreadId = null
    }, 0)
    return () => clearTimeout(timer)
  }, [threadId])

  // Restores the caret after a chip pick rewrites the draft.
  useLayoutEffect(() => {
    if (caret.current === null) return
    ref.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  })

  const readMention = (value: string, caret: number) => {
    const match = /(^|\s)@([\w.:-]*)$/.exec(value.slice(0, caret))
    setMention(match && skills.length > 0 ? { start: caret - match[2].length - 1, query: match[2] } : null)
    setActive(0)
  }

  const pick = (name: string) => {
    if (!mention) return
    const { start } = mention
    setDraft(draft.slice(0, start) + draft.slice(start + 1 + mention.query.length))
    setSkill(name)
    setMention(null)
    caret.current = start
  }

  const attach = async (files: File[]) => {
    const pictures = files.flatMap((file) => (isImageMime(file.type) ? [{ file, mime: file.type }] : []))
    if (!pictures.length || !window.hidegpt) return
    // Every picture settles: the ones that saved are attached, and the first
    // failure goes on the banner (main's sentence, or a plain one when the file
    // could not be read or the request never reached main).
    const settled = await Promise.allSettled(
      pictures.map(async ({ file, mime }) => window.hidegpt.saveImage({ bytes: new Uint8Array(await file.arrayBuffer()), mime })),
    )
    const paths: string[] = []
    let failure: string | null = null
    for (const outcome of settled) {
      if (outcome.status === 'rejected') failure ??= 'Docs could not attach that image.'
      else if (outcome.value.ok) paths.push(outcome.value.path)
      else failure ??= outcome.value.error
    }
    if (paths.length) setImages((current) => [...current, ...paths])
    if (failure) showRequestError(failure)
  }

  // The draft clears only once main accepts the question; a failed send keeps
  // it (the banner says why) so nothing typed is lost.
  const submit = async () => {
    if (streaming || sending || (!draft.trim() && !images.length && !skill)) return
    setSending(true)
    const result = await dispatch({ op: 'send', text: draft, ...(skill ? { skill } : {}), ...(images.length ? { images } : {}) })
    setSending(false)
    if (!result.ok) return
    setDraft('')
    setSkill(null)
    setImages([])
    setMention(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (matches.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((active + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        pick(matches[active]?.name ?? matches[0].name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
    if (event.key === 'Backspace' && atStart && (skill || images.length)) {
      event.preventDefault()
      if (skill) setSkill(null)
      else setImages(images.slice(0, -1))
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (!files.some((file) => isImageMime(file.type))) return
    event.preventDefault()
    void attach(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    void attach(Array.from(event.dataTransfer.files))
  }

  return (
    <div
      className="composer-wrap"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={onDrop}
    >
      {images.length > 0 ? (
        <div className="doc-images" data-testid="composer-images">
          {images.map((path, index) => (
            <span className="doc-image" key={path}>
              <img src={imageSrc(path)} alt="" />
              <button
                type="button"
                className="doc-image-remove"
                aria-label="Remove image"
                onClick={() => setImages(images.filter((_, other) => other !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-line">
        {skill ? <SkillChip name={skill} onRemove={() => setSkill(null)} /> : null}
        <textarea
          ref={ref}
          className="composer"
          data-testid="composer"
          aria-label="Ask a question"
          value={draft}
          placeholder={streaming ? 'Working…' : 'Type a question'}
          rows={1}
          onChange={(event) => {
            setDraft(event.target.value)
            readMention(event.target.value, event.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setMention(null)}
        />
      </div>
      {matches.length > 0 ? <SkillMenu skills={matches} active={active} onPick={pick} onHover={setActive} /> : null}
      <input
        id={IMAGE_INPUT_ID}
        type="file"
        accept={IMAGE_MIME_TYPES.join(',')}
        multiple
        hidden
        onChange={(event) => {
          void attach(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
    </div>
  )
})

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { dispatch } from '../../session-bridge'
import { takePendingDraft } from '../../templates'

let lastConsumedThreadId: string | null = null
let lastConsumedDraft = ''

function consumeDraftOnce(threadId: string): string {
  if (lastConsumedThreadId === threadId) return lastConsumedDraft
  const text = takePendingDraft()
  lastConsumedThreadId = threadId
  lastConsumedDraft = text
  return text
}

export function Composer({ threadId, streaming }: { threadId: string; streaming: boolean }) {
  const [draft, setDraft] = useState(() => consumeDraftOnce(threadId))
  const ref = useRef<HTMLTextAreaElement>(null)

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

  const submit = () => {
    if (streaming || !draft.trim()) return
    const text = draft
    setDraft('')
    dispatch({ op: 'send', text })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <textarea
      ref={ref}
      className="composer"
      data-testid="composer"
      aria-label="Ask a question"
      value={draft}
      placeholder={streaming ? 'Working…' : 'Type a question'}
      rows={1}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

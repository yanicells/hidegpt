import { useEffect, useRef, useState, type KeyboardEvent, type RefObject, type UIEvent } from 'react'

import type { Block } from '../../codex/blocks'
import { formFields, inputQuestions } from '../../codex/labels'
import type { Snapshot } from '../../codex/types'
import { AccountMenu, DocMenus, Toolbar } from './chrome'
import { ChevronIcon, CloudIcon, DocsIcon } from './icons'
import { AgentMarkdown } from './markdown'
import { dispatch } from './session-bridge'
import { takePendingDraft } from './templates'

export function DocumentChrome({
  snap,
  titleRef,
  onGrid,
  onList,
}: {
  snap: Snapshot
  titleRef: RefObject<HTMLInputElement | null>
  onGrid: () => void
  onList: () => void
}) {
  // Local text only exists while the field is focused; otherwise the session title is shown.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    const next = (draft ?? snap.title).trim() || 'Untitled document'
    if (next !== snap.title) dispatch({ op: 'setDocumentName', name: next })
    setDraft(null)
  }

  return (
    <header className="doc-chrome">
      <div className="doc-top">
        <button type="button" className="doc-home" aria-label="Docs home" onClick={() => dispatch({ op: 'goHome' })}>
          <DocsIcon size={40} />
        </button>
        <div className="doc-head">
          <div className="doc-title-row">
            <input
              ref={titleRef}
              className="doc-title"
              value={draft ?? snap.title}
              aria-label="Document title"
              spellCheck={false}
              onFocus={() => setDraft(snap.title)}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  setDraft(null)
                  event.currentTarget.blur()
                }
              }}
            />
            <span
              className="save-state"
              role="status"
              aria-label={snap.streaming ? 'Working' : 'Saved'}
              title={snap.streaming ? 'Working…' : 'Saved to Codex'}
            >
              <CloudIcon busy={snap.streaming} />
            </span>
          </div>
          <DocMenus snap={snap} onRename={() => titleRef.current?.focus()} onGrid={onGrid} onList={onList} />
        </div>
        <div className="header-end">
          <AccountMenu snap={snap} />
        </div>
      </div>
      <Toolbar snap={snap} />
    </header>
  )
}

export function Document({ snap }: { snap: Snapshot }) {
  const threadId = snap.route.kind === 'doc' ? snap.route.threadId : ''
  const lastBlock = snap.blocks[snap.blocks.length - 1]
  const streamingAgentId = snap.streaming && lastBlock?.kind === 'agent' ? lastBlock.id : null
  const waiting = snap.streaming && streamingAgentId === null

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const seenBlocks = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    const grew = snap.blocks.length !== seenBlocks.current
    seenBlocks.current = snap.blocks.length
    if (!el || snap.blocks.length === 0) return
    if ((grew || snap.streaming) && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [snap.blocks, snap.streaming])
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  return (
    <div className="workspace" data-testid="document" ref={scrollRef} onScroll={onScroll}>
      <div className="ruler" aria-hidden="true" />
      <article className="paper">
        {snap.olderTurnsCursor ? (
          <button
            type="button"
            className="load-older"
            data-testid="load-older"
            disabled={snap.loadingOlder}
            onClick={() => dispatch({ op: 'loadOlderTurns' })}
          >
            {snap.loadingOlder ? 'Loading…' : 'Load earlier'}
          </button>
        ) : null}
        {snap.blocks.map((block) => (
          <div className="doc-block" key={block.id}>
            <BlockView block={block} streaming={block.id === streamingAgentId} />
          </div>
        ))}
        {waiting ? (
          <p className="doc-body pending" aria-live="polite" aria-label="Working">
            <span className="caret" />
          </p>
        ) : null}
        <Composer key={threadId} streaming={snap.streaming} />
      </article>
      {snap.streaming ? (
        <div className="stop-wrap">
          <button type="button" className="stop" data-testid="stop-turn" onClick={() => dispatch({ op: 'interrupt' })}>
            <span className="stop-square" aria-hidden="true" />
            Stop
          </button>
        </div>
      ) : null}
    </div>
  )
}

function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  if (block.kind === 'user') {
    return <h1 className="doc-heading">{block.text}</h1>
  }
  if (block.kind === 'agent') {
    return (
      <div className={streaming ? 'streaming' : undefined}>
        <AgentMarkdown text={block.text} />
        {streaming ? <span className="caret" /> : null}
      </div>
    )
  }
  if (block.kind === 'callout') {
    return (
      <details className="callout">
        <summary>
          <ChevronIcon />
          {block.title}
        </summary>
        {block.body ? <pre>{block.body}</pre> : null}
      </details>
    )
  }
  return <Approval block={block} />
}

function Approval({ block }: { block: Extract<Block, { kind: 'approval' }> }) {
  const fields = formFields(block)
  const questions = inputQuestions(block)
  const setDraft = (key: string, value: string) => dispatch({ op: 'setApprovalDraft', blockId: block.id, key, value })
  return (
    <div className={`approval${block.resolved ? ' done' : ''}`} data-testid={`approval-${block.id}`}>
      <div className="approval-head">
        <span className="approval-eyebrow">{block.resolved ? 'Suggestion' : 'Suggestion · needs your reply'}</span>
        <h3>{block.title}</h3>
      </div>
      {block.body ? <p>{block.body}</p> : null}
      {!block.resolved
        ? fields.map((field) => (
            <label key={field.key} className="field">
              <span>{field.label}</span>
              <input
                data-testid={`draft-${block.id}-${field.key}`}
                value={block.drafts[field.key] ?? ''}
                onChange={(event) => setDraft(field.key, event.target.value)}
              />
            </label>
          ))
        : null}
      {!block.resolved
        ? questions.map((question) => (
            <div key={question.id} className="field">
              <span>{question.question}</span>
              {question.options?.length ? (
                <div className="choices" role="radiogroup" aria-label={question.question}>
                  {question.options.map((option) => {
                    const on = block.drafts[question.id] === option.label
                    return (
                      <button
                        type="button"
                        key={option.label}
                        role="radio"
                        aria-checked={on}
                        className={`choice${on ? ' on' : ''}`}
                        onClick={() => setDraft(question.id, option.label)}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {question.isOther || !question.options?.length ? (
                <input
                  data-testid={`draft-${block.id}-${question.id}`}
                  aria-label={question.question}
                  value={block.drafts[question.id] ?? ''}
                  onChange={(event) => setDraft(question.id, event.target.value)}
                />
              ) : null}
            </div>
          ))
        : null}
      {block.resolved ? (
        <span className="resolved">{block.resolved === 'accepted' ? 'Accepted' : 'Skipped'}</span>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="accept"
            data-testid={`accept-${block.id}`}
            onClick={() => dispatch({ op: 'resolveApproval', blockId: block.id, accept: true })}
          >
            Accept
          </button>
          <button
            type="button"
            className="skip"
            data-testid={`skip-${block.id}`}
            onClick={() => dispatch({ op: 'resolveApproval', blockId: block.id, accept: false })}
          >
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

function Composer({ streaming }: { streaming: boolean }) {
  const [draft, setDraft] = useState(() => takePendingDraft())
  const ref = useRef<HTMLTextAreaElement>(null)

  // Remounted per thread, so this runs once per opened document.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

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

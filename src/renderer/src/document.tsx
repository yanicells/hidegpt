import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

import { formFields, inputQuestions } from '../../codex/labels'
import type { Block } from '../../codex/blocks'
import type { Snapshot } from '../../codex/types'
import { AccountMenu, DocMenus, Toolbar } from './chrome'
import { DocsIcon } from './icons'
import { AgentMarkdown } from './markdown'
import { dispatch } from './session-bridge'

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
  const [title, setTitle] = useState(snap.title)
  useEffect(() => {
    setTitle(snap.title)
  }, [snap.title])

  const commit = () => {
    const next = title.trim() || 'Untitled document'
    setTitle(next)
    if (next !== snap.title) dispatch({ op: 'setDocumentName', name: next })
  }

  return (
    <header className="doc-chrome">
      <div className="doc-top">
        <button
          type="button"
          className="doc-home"
          aria-label="Docs home"
          onClick={() => dispatch({ op: 'goHome' })}
        >
          <DocsIcon size={40} />
        </button>
        <input
          ref={titleRef}
          className="doc-title"
          value={title}
          aria-label="Document title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
        />
        <AccountMenu snap={snap} />
      </div>
      <DocMenus
        snap={snap}
        onRename={() => titleRef.current?.focus()}
        onGrid={onGrid}
        onList={onList}
      />
      <Toolbar snap={snap} />
    </header>
  )
}

export function Document({ snap }: { snap: Snapshot }) {
  const lastAgent = [...snap.blocks].reverse().find((block) => block.kind === 'agent')

  return (
    <div className="workspace" data-testid="document">
      <article className="paper">
        {snap.olderTurnsCursor ? (
          <button
            type="button"
            className="load-older"
            data-testid="load-older"
            onClick={() => dispatch({ op: 'loadOlderTurns' })}
          >
            {snap.loadingOlder ? 'Loading…' : 'Load earlier'}
          </button>
        ) : null}
        {snap.blocks.map((block) => (
          <div className="doc-block" key={block.id}>
            <BlockView
              block={block}
              streaming={snap.streaming && lastAgent?.id === block.id}
            />
          </div>
        ))}
        {snap.streaming ? (
          <button type="button" className="stop" data-testid="stop-turn" onClick={() => dispatch({ op: 'interrupt' })}>
            Stop
          </button>
        ) : null}
        <Composer streaming={snap.streaming} threadId={snap.route.kind === 'doc' ? snap.route.threadId : ''} />
      </article>
    </div>
  )
}

function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  if (block.kind === 'user') {
    return <h1 className="doc-heading">{block.text}</h1>
  }
  if (block.kind === 'agent') {
    return (
      <div>
        <AgentMarkdown text={block.text} />
        {streaming ? <span className="caret" /> : null}
      </div>
    )
  }
  if (block.kind === 'callout') {
    return (
      <details className="callout">
        <summary>{block.title}</summary>
        {block.body ? <pre>{block.body}</pre> : null}
      </details>
    )
  }
  return <Approval block={block} />
}

function Approval({ block }: { block: Extract<Block, { kind: 'approval' }> }) {
  const fields = formFields(block)
  const questions = inputQuestions(block)
  return (
    <div className="approval" data-testid={`approval-${block.id}`}>
      <h3>{block.title}</h3>
      <p>{block.body}</p>
      {!block.resolved
        ? fields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                data-testid={`draft-${block.id}-${field.key}`}
                value={block.drafts[field.key] ?? ''}
                onChange={(event) =>
                  dispatch({
                    op: 'setApprovalDraft',
                    blockId: block.id,
                    key: field.key,
                    value: event.target.value,
                  })
                }
              />
            </label>
          ))
        : null}
      {!block.resolved
        ? questions.map((question) => (
            <label key={question.id}>
              {question.question}
              <div className="choices">
                {(question.options ?? []).map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    className={`choice${block.drafts[question.id] === option.label ? ' on' : ''}`}
                    onClick={() =>
                      dispatch({
                        op: 'setApprovalDraft',
                        blockId: block.id,
                        key: question.id,
                        value: option.label,
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {question.isOther || !question.options?.length ? (
                <input
                  data-testid={`draft-${block.id}-${question.id}`}
                  value={block.drafts[question.id] ?? ''}
                  onChange={(event) =>
                    dispatch({
                      op: 'setApprovalDraft',
                      blockId: block.id,
                      key: question.id,
                      value: event.target.value,
                    })
                  }
                />
              ) : null}
            </label>
          ))
        : null}
      {block.resolved ? (
        <span className="resolved">{block.resolved}</span>
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

function Composer({ streaming, threadId }: { streaming: boolean; threadId: string }) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft('')
  }, [threadId])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(24, el.scrollHeight)}px`
  }, [draft])

  const submit = () => {
    if (streaming) return
    const text = draft
    setDraft('')
    dispatch({ op: 'send', text })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <textarea
      ref={ref}
      className="composer"
      data-testid="composer"
      value={draft}
      placeholder={streaming ? 'Working…' : 'Type a question'}
      rows={1}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

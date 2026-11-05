import { useState } from 'react'

import type { ApprovalBlock } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'

/** Starting answers: each field's `initial` value; questions start blank. */
function initialAnswers(block: ApprovalBlock): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of block.fields) if (field.initial !== undefined) answers[field.id] = field.initial
  return answers
}

// Answers are drafted locally and sent once with the reply; buttons stay
// disabled while that reply is on its way. Adapted from T3 Code
// (apps/web/src/components/chat/usePendingThreadRequests.ts and
// ComposerPendingApprovalActions.tsx) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/** A suggestion waiting on the person: optional fields and questions, then Accept or Skip. */
export function Approval({ block }: { block: ApprovalBlock }) {
  const [answers, setAnswers] = useState(() => initialAnswers(block))
  // Covers the gap between the click and main marking the block pending.
  const [sending, setSending] = useState(false)
  const busy = sending || Boolean(block.pending)
  const setAnswer = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }))
  const reply = async (accept: boolean) => {
    if (busy) return
    setSending(true)
    await dispatch({ op: 'resolveApproval', blockId: block.id, accept, answers })
    setSending(false)
  }
  return (
    <div className={`approval${block.resolved ? ' done' : ''}`} data-testid={`approval-${block.id}`}>
      <span className="approval-eyebrow">{block.resolved ? 'Suggestion' : 'Suggestion · needs your reply'}</span>
      <h3>{block.title}</h3>
      {block.body ? <p>{block.body}</p> : null}
      {!block.resolved
        ? block.fields.map((field) => (
            <label key={field.id} className="field">
              <span>{field.label}</span>
              <input
                data-testid={`draft-${block.id}-${field.id}`}
                value={answers[field.id] ?? ''}
                disabled={busy}
                onChange={(event) => setAnswer(field.id, event.target.value)}
              />
            </label>
          ))
        : null}
      {!block.resolved
        ? block.questions.map((question) => (
            <div key={question.id} className="field">
              <span>{question.question}</span>
              {question.options.length ? (
                <div className="choices" role="radiogroup" aria-label={question.question}>
                  {question.options.map((option) => {
                    const on = answers[question.id] === option
                    return (
                      <button
                        type="button"
                        key={option}
                        role="radio"
                        aria-checked={on}
                        className={`choice${on ? ' on' : ''}`}
                        disabled={busy}
                        onClick={() => setAnswer(question.id, option)}
                      >
                        {option}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {question.allowText || !question.options.length ? (
                <input
                  data-testid={`draft-${block.id}-${question.id}`}
                  aria-label={question.question}
                  value={answers[question.id] ?? ''}
                  disabled={busy}
                  onChange={(event) => setAnswer(question.id, event.target.value)}
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
            disabled={busy}
            onClick={() => void reply(true)}
          >
            Accept
          </button>
          <button
            type="button"
            className="skip"
            data-testid={`skip-${block.id}`}
            disabled={busy}
            onClick={() => void reply(false)}
          >
            Skip
          </button>
          {busy ? (
            <span className="resolved" role="status">
              Sending…
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

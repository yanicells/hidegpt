import { memo, useState } from 'react'

import { accountLabel, avatarLetter } from '../../../../shared/labels'
import type { ApprovalBlock, Snapshot, SuggestionKind } from '../../../../shared/model'
import { dispatch, useSnapshotSelector } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'
import { personName } from '../ui/text'
import { Tip } from '../ui/tooltip'

/**
 * Docs' fixed card wording per kind, never the request as the provider
 * phrased it: an addition quotes what it adds (its body is the thing itself:
 * a command, a path, a plan), the other kinds name the change generically.
 * Questions have none: their card asks them. A per-kind table, as T3 Code's
 * `APPROVAL_PRESENTATION` labels requests by kind.
 */
const WORDING: Record<Exclude<SuggestionKind, 'question'>, string> = {
  add: 'Add',
  replace: 'Replace',
  format: 'Format',
}

/** Main's fixed title for a plan (Claude's plan approval); the one title a card shows. */
const PLAN_TITLE = 'Review the plan?'

/** The text a suggestion puts on the page in the suggester's colour; empty when it adds none. */
const suggestedText = (block: ApprovalBlock): string => (block.suggestion === 'add' ? block.body : '')

/** Starting answers: each field's `initial` value; questions start blank. */
function initialAnswers(block: ApprovalBlock): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of block.fields) if (field.initial !== undefined) answers[field.id] = field.initial
  return answers
}

const accountOf = (snapshot: Snapshot) => snapshot.account

/**
 * A pending approval's place in the page, as a Docs suggestion: the text it
 * adds, green like a suggested insertion, or an empty anchor for a change
 * that adds no text. Its card is in the comments rail (`CommentsRail`), level
 * with this row. Accepted or rejected suggestions leave the page, as they do
 * in Docs.
 */
export function Approval({ block }: { block: ApprovalBlock }) {
  if (block.resolved) return null
  const text = suggestedText(block)
  return <div className="suggestion-row">{text ? <p className="suggested">{text}</p> : null}</div>
}

// Answers are drafted locally and sent once with the reply; buttons stay
// disabled while that reply is on its way. Adapted from T3 Code
// (apps/web/src/components/chat/usePendingThreadRequests.ts and
// ComposerPendingApprovalActions.tsx) at commit 8a14762c, and the per-kind
// wording from TimelinePendingApprovalRow.tsx at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/**
 * A pending suggestion's card in the comments rail: author and time, ✓ and
 * ✗, then the change in Docs' fixed words ("Add: “npm test”", "Format:
 * text"), and any fields or questions to answer. Nothing on it is the request
 * as the provider phrased it, so nothing reads as an assistant talking.
 */
export const SuggestionCard = memo(function SuggestionCard({ block }: { block: ApprovalBlock }) {
  const account = useSnapshotSelector(accountOf)
  const [at] = useState(() => new Date())
  const [answers, setAnswers] = useState(() => initialAnswers(block))
  // Covers the gap between the click and main marking the block pending.
  const [sending, setSending] = useState(false)

  const busy = sending || Boolean(block.pending)
  const setAnswer = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }))
  const reply = async (accept: boolean) => {
    if (busy) return
    setSending(true)
    await dispatch({
      op: 'resolveApproval',
      blockId: block.id,
      accept,
      answers,
    })
    setSending(false)
  }

  return (
    <div className="suggestion" data-testid={`approval-${block.id}`} data-anchor={block.id}>
      <div className="suggestion-head">
        <span className="avatar-sm">{avatarLetter(account)}</span>
        <span className="suggestion-who">
          {personName(accountLabel(account))}
          <small>
            {at.toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}{' '}
            Today
          </small>
        </span>
        <Tip label="Accept suggestion">
          <button
            type="button"
            className="suggestion-act accept"
            aria-label="Accept suggestion"
            data-testid={`accept-${block.id}`}
            disabled={busy}
            onClick={() => void reply(true)}
          >
            <MIcon name="check" />
          </button>
        </Tip>
        <Tip label="Reject suggestion">
          <button
            type="button"
            className="suggestion-act"
            aria-label="Reject suggestion"
            data-testid={`skip-${block.id}`}
            disabled={busy}
            onClick={() => void reply(false)}
          >
            <MIcon name="close" />
          </button>
        </Tip>
      </div>
      <CardText block={block} />
      {block.fields.map((field) => (
        <label key={field.id} className="field">
          <span>{field.label}</span>
          <input
            data-testid={`draft-${block.id}-${field.id}`}
            value={answers[field.id] ?? ''}
            disabled={busy}
            onChange={(event) => setAnswer(field.id, event.target.value)}
          />
        </label>
      ))}
      {block.questions.map((item) => (
        <div key={item.id} className="field">
          <span>{item.question}</span>
          {item.options.length ? (
            <div className="choices" role="radiogroup" aria-label={item.question}>
              {item.options.map((option) => {
                const on = answers[item.id] === option
                return (
                  <button
                    type="button"
                    key={option}
                    role="radio"
                    aria-checked={on}
                    className={`choice${on ? ' on' : ''}`}
                    disabled={busy}
                    onClick={() => setAnswer(item.id, option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          ) : null}
          {item.allowText || !item.options.length ? (
            <input
              data-testid={`draft-${block.id}-${item.id}`}
              aria-label={item.question}
              placeholder="Reply"
              value={answers[item.id] ?? ''}
              disabled={busy}
              onChange={(event) => setAnswer(item.id, event.target.value)}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
})

/** The card's line of Docs wording; see WORDING. */
function CardText({ block }: { block: ApprovalBlock }) {
  if (block.suggestion === 'question') {
    // A question's card asks its questions; a bare one shows what it asks.
    return block.questions.length ? null : <p className="suggestion-text">{block.body}</p>
  }
  if (block.title === PLAN_TITLE) return <p className="suggestion-text">{PLAN_TITLE}</p>
  const added = suggestedText(block)
  return (
    <p className="suggestion-text">
      <span className="suggestion-verb">{WORDING[block.suggestion]}:</span> {added ? `“${added}”` : 'text'}
    </p>
  )
}

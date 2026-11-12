import { useState } from 'react'

import { accountLabel, avatarLetter } from '../../../../shared/labels'
import type { ApprovalBlock, Snapshot, SuggestionKind } from '../../../../shared/model'
import { dispatchToDocument, useSnapshotSelector } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'
import { personName } from '../ui/text'
import { Tip } from '../ui/tooltip'

/** Docs' suggestion verb for each kind of change. Questions have none: their card asks them. */
const VERBS: Record<Exclude<SuggestionKind, 'question'>, string> = {
  add: 'Add',
  replace: 'Replace',
  format: 'Format',
}

/** Starting answers: each field's `initial` value; questions start blank. */
function initialAnswers(block: ApprovalBlock): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of block.fields) if (field.initial !== undefined) answers[field.id] = field.initial
  return answers
}

const accountOf = (snapshot: Snapshot) => snapshot.account

// Answers are drafted locally and sent once with the reply; buttons stay
// disabled while that reply is on its way. Adapted from T3 Code
// (apps/web/src/components/chat/usePendingThreadRequests.ts and
// ComposerPendingApprovalActions.tsx) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/**
 * A pending approval as a Docs suggestion: the suggested text in the page,
 * green like a suggested insertion, with its card beside it. The card shows
 * author and time, ✓ and ✗, then the change in Docs' words ("Add: “npm
 * test”"). The request as the provider phrased it ("Run command?") waits in
 * a delayed hover, the way model names do, so nothing on the page reads as
 * an assistant talking. Accepted or rejected suggestions leave the page, as
 * they do in Docs.
 */
export function Approval({ block }: { block: ApprovalBlock }) {
  const account = useSnapshotSelector(accountOf)
  const [at] = useState(() => new Date())
  const [answers, setAnswers] = useState(() => initialAnswers(block))
  // Covers the gap between the click and main marking the block pending.
  const [sending, setSending] = useState(false)
  if (block.resolved) return null

  const busy = sending || Boolean(block.pending)
  const setAnswer = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }))
  const reply = async (accept: boolean) => {
    if (busy) return
    setSending(true)
    await dispatchToDocument({ op: 'resolveApproval', blockId: block.id, accept, answers })
    setSending(false)
  }

  const question = block.suggestion === 'question'
  const request = block.title.replace(/\?$/, '')
  // An addition's body is the thing itself (a command, a path), so the card quotes it.
  const quoted = block.suggestion === 'add' && block.body ? block.body : request
  // Additions and replacements put text on the page; format changes and questions don't.
  const inline = block.suggestion === 'add' || block.suggestion === 'replace'
  const real = [block.title, quoted === block.body ? '' : block.body].filter(Boolean).join('\n')

  return (
    <div className="suggestion-row">
      {inline ? <p className="suggested">{quoted}</p> : null}
      <div className="suggestion" data-testid={`approval-${block.id}`}>
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
        {!question ? (
          <Tip label={real} side="left" delay={1200}>
            <p className="suggestion-text">
              <span className="suggestion-verb">{VERBS[block.suggestion]}:</span> “{quoted}”
            </p>
          </Tip>
        ) : block.questions.length ? null : (
          <p className="suggestion-text">{block.body}</p>
        )}
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
    </div>
  )
}

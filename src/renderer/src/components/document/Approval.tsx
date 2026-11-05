import { useState } from 'react'

import type { Block } from '../../../../codex/blocks'
import { accountLabel, avatarLetter, formFields, inputQuestions } from '../../../../codex/labels'
import { dispatch, useSnapshot } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'
import { personName } from '../ui/text'
import { Tip } from '../ui/tooltip'

type ApprovalBlock = Extract<Block, { kind: 'approval' }>

/** Requests whose body is the thing being approved (a command, path or message), so it's quoted on the card. */
const QUOTED_BODY = new Set([
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'claude/canUseTool',
  'mcpServer/elicitation/request',
])

/** Requests that ask questions; the questions render as reply fields. */
const QUESTIONS = new Set(['item/tool/requestUserInput', 'opencode/question'])

/**
 * A pending approval as Docs' suggestion card: author and time, ✓ and ✗,
 * then the change itself ("Run command? “npm test”"). Accepted or rejected
 * suggestions leave the page, as they do in Docs. Any explanation the
 * provider sends waits in a delayed hover on the action, so nothing on the
 * page reads as an assistant talking.
 */
export function Approval({ block }: { block: ApprovalBlock }) {
  // Pending approvals pause the turn, so this re-renders only when the account or card changes.
  const { account } = useSnapshot()
  const [at] = useState(() => new Date())
  if (block.resolved) return null

  const fields = formFields(block)
  const questions = inputQuestions(block)
  const asks = QUESTIONS.has(block.method)
  const quoted = QUOTED_BODY.has(block.method) && block.body ? block.body : null
  const note = !asks && !quoted && block.body ? block.body : undefined
  const setDraft = (key: string, value: string) => dispatch({ op: 'setApprovalDraft', blockId: block.id, key, value })
  const resolve = (accept: boolean) => dispatch({ op: 'resolveApproval', blockId: block.id, accept })

  return (
    <div className="suggestion" data-testid={`approval-${block.id}`}>
      <div className="suggestion-head">
        <span className="avatar-sm">{avatarLetter(account)}</span>
        <span className="suggestion-who">
          {personName(accountLabel(account))}
          <small>{at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} Today</small>
        </span>
        <Tip label="Accept suggestion">
          <button
            type="button"
            className="suggestion-act accept"
            aria-label="Accept suggestion"
            data-testid={`accept-${block.id}`}
            onClick={() => resolve(true)}
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
            onClick={() => resolve(false)}
          >
            <MIcon name="close" />
          </button>
        </Tip>
      </div>
      <p className="suggestion-text">
        <Tip label={note} delay={1200}>
          <span className="suggestion-verb">{asks ? 'Reply needed' : block.title}</span>
        </Tip>
        {quoted ? <> “{quoted}”</> : null}
      </p>
      {fields.map((field) => (
        <label key={field.key} className="field">
          <span>{field.label}</span>
          <input
            data-testid={`draft-${block.id}-${field.key}`}
            value={block.drafts[field.key] ?? ''}
            onChange={(event) => setDraft(field.key, event.target.value)}
          />
        </label>
      ))}
      {questions.map((question) => (
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
              placeholder="Reply"
              value={block.drafts[question.id] ?? ''}
              onChange={(event) => setDraft(question.id, event.target.value)}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

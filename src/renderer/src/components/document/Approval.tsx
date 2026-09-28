import type { Block } from '../../../../codex/blocks'
import { formFields, inputQuestions } from '../../../../codex/labels'
import { dispatch } from '../../session-bridge'

export function Approval({ block }: { block: Extract<Block, { kind: 'approval' }> }) {
  const fields = formFields(block)
  const questions = inputQuestions(block)
  const setDraft = (key: string, value: string) => dispatch({ op: 'setApprovalDraft', blockId: block.id, key, value })
  return (
    <div className={`approval${block.resolved ? ' done' : ''}`} data-testid={`approval-${block.id}`}>
      <span className="approval-eyebrow">{block.resolved ? 'Suggestion' : 'Suggestion · needs your reply'}</span>
      <h3>{block.title}</h3>
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

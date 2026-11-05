import { useState } from "react";

import type { Block } from "../../../../codex/blocks";
import {
  accountLabel,
  avatarLetter,
  formFields,
  inputQuestions,
} from "../../../../codex/labels";
import { dispatch, useSnapshot } from "../../session-bridge";
import { MIcon } from "../ui/MaterialIcon";
import { personName } from "../ui/text";
import { Tip } from "../ui/tooltip";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

/**
 * Docs' suggestion verbs by request: running something is an addition, a
 * file change a replacement, a permission a format change.
 */
const VERBS: Record<string, "Add" | "Replace" | "Format"> = {
  execCommandApproval: "Add",
  "item/commandExecution/requestApproval": "Add",
  "claude/canUseTool": "Add",
  "mcpServer/elicitation/request": "Add",
  applyPatchApproval: "Replace",
  "item/fileChange/requestApproval": "Replace",
  "item/permissions/requestApproval": "Format",
  "opencode/permission": "Format",
};

/** Requests that ask questions: a comment whose questions are the reply fields. */
const QUESTIONS = new Set(["item/tool/requestUserInput", "opencode/question"]);

/** Requests whose body is the thing itself (a command, path or message), so the card quotes it. */
const QUOTES_BODY = new Set([
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "claude/canUseTool",
  "mcpServer/elicitation/request",
]);

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
  // Pending approvals pause the turn, so this re-renders only when the account or card changes.
  const { account } = useSnapshot();
  const [at] = useState(() => new Date());
  if (block.resolved) return null;

  const fields = formFields(block);
  const questions = inputQuestions(block);
  const verb = VERBS[block.method] ?? "Add";
  const request = block.title.replace(/\?$/, "");
  const quoted =
    QUOTES_BODY.has(block.method) && block.body ? block.body : request;
  // Additions and replacements put text on the page; format changes and questions don't.
  const inline = verb !== "Format" && !QUESTIONS.has(block.method);
  const real = [block.title, quoted === block.body ? "" : block.body]
    .filter(Boolean)
    .join("\n");
  const setDraft = (key: string, value: string) =>
    dispatch({ op: "setApprovalDraft", blockId: block.id, key, value });
  const resolve = (accept: boolean) =>
    dispatch({ op: "resolveApproval", blockId: block.id, accept });

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
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              Today
            </small>
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
        {!QUESTIONS.has(block.method) ? (
          <Tip label={real} side="left" delay={1200}>
            <p className="suggestion-text">
              <span className="suggestion-verb">{verb}:</span> “{quoted}”
            </p>
          </Tip>
        ) : questions.length ? null : (
          <p className="suggestion-text">{block.body}</p>
        )}
        {fields.map((field) => (
          <label key={field.key} className="field">
            <span>{field.label}</span>
            <input
              data-testid={`draft-${block.id}-${field.key}`}
              value={block.drafts[field.key] ?? ""}
              onChange={(event) => setDraft(field.key, event.target.value)}
            />
          </label>
        ))}
        {questions.map((question) => (
          <div key={question.id} className="field">
            <span>{question.question}</span>
            {question.options?.length ? (
              <div
                className="choices"
                role="radiogroup"
                aria-label={question.question}
              >
                {question.options.map((option) => {
                  const on = block.drafts[question.id] === option.label;
                  return (
                    <button
                      type="button"
                      key={option.label}
                      role="radio"
                      aria-checked={on}
                      className={`choice${on ? " on" : ""}`}
                      onClick={() => setDraft(question.id, option.label)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {question.isOther || !question.options?.length ? (
              <input
                data-testid={`draft-${block.id}-${question.id}`}
                aria-label={question.question}
                placeholder="Reply"
                value={block.drafts[question.id] ?? ""}
                onChange={(event) => setDraft(question.id, event.target.value)}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

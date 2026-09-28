import { useLayoutEffect, useRef, useState } from 'react'

import type { Skill } from '../../../../codex/types'

/** A skill attached to a question, drawn like a Docs smart chip. */
export function SkillChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="smart-chip" data-testid={`chip-skill-${name}`}>
      <ChipIcon />
      <span>{name}</span>
      {onRemove ? (
        <button type="button" className="smart-chip-remove" aria-label={`Remove ${name}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  )
}

/** The "@" menu, styled after the Docs smart-chip insert menu. */
export function SkillMenu({
  skills,
  active,
  onPick,
  onHover,
}: {
  skills: Skill[]
  active: number
  onPick: (name: string) => void
  onHover: (index: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [up, setUp] = useState(false)
  // Opens below like Docs, unless the composer sits too close to the window bottom.
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement?.getBoundingClientRect()
    if (anchor) setUp(anchor.bottom + 320 > window.innerHeight && anchor.top > 320)
  }, [])
  return (
    <div
      ref={ref}
      className={`chip-menu${up ? ' up' : ''}`}
      role="listbox"
      aria-label="Smart chips"
      data-testid="skill-menu"
    >
      <div className="chip-menu-head">Smart chips</div>
      {skills.map((skill, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === active}
          key={skill.name}
          className={`chip-menu-item${index === active ? ' active' : ''}`}
          data-testid={`skill-${skill.name}`}
          // mousedown keeps focus in the composer so the caret survives the pick
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(skill.name)
          }}
          onMouseEnter={() => onHover(index)}
        >
          <ChipIcon />
          <span className="chip-menu-text">
            <span className="chip-menu-name">{skill.name}</span>
            {skill.description ? <span className="chip-menu-desc">{skill.description}</span> : null}
          </span>
        </button>
      ))}
    </div>
  )
}

function ChipIcon() {
  return (
    <svg className="chip-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm4 18H6V4h7v5h5v11ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"
      />
    </svg>
  )
}

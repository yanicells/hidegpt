import { dispatch } from '../../session-bridge'
import { setPendingDraft, type Template } from '../../templates'
import { PlusIcon } from '../ui/Icons'

export function TemplateCard({ template }: { template: Template }) {
  const blank = template.id === 'blank'
  return (
    <div className="template">
      <button
        type="button"
        className={`template-card${blank ? ' blank' : ''}`}
        data-testid={blank ? 'new-doc' : `template-${template.id}`}
        aria-label={blank ? 'Blank document' : `${template.title} template`}
        onClick={() => {
          setPendingDraft(template.prompt)
          dispatch({ op: 'newDocument' })
        }}
      >
        {blank ? <PlusIcon /> : <PageSketch sketch={template.sketch} />}
      </button>
      <span className="template-title">{blank ? 'Blank document' : template.title}</span>
      {template.category ? <span className="template-category">{template.category}</span> : null}
    </div>
  )
}

export type Stroke = { k: 'title' | 'sub' | 'h' | 'line' | 'bullet' | 'box' | 'table' | 'right' | 'gap'; w?: number }

export const SKETCHES: Record<Template['sketch'], Stroke[]> = {
  blank: [],
  essay: [
    { k: 'title', w: 62 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 96 },
    { k: 'line', w: 100 },
    { k: 'line', w: 58 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 92 },
    { k: 'line', w: 100 },
    { k: 'line', w: 74 },
  ],
  notes: [
    { k: 'title', w: 54 },
    { k: 'gap' },
    { k: 'h', w: 40 },
    { k: 'bullet', w: 70 },
    { k: 'bullet', w: 56 },
    { k: 'bullet', w: 64 },
    { k: 'gap' },
    { k: 'h', w: 34 },
    { k: 'bullet', w: 60 },
    { k: 'bullet', w: 48 },
  ],
  guide: [
    { k: 'title', w: 58 },
    { k: 'gap' },
    { k: 'h', w: 30 },
    { k: 'line', w: 100 },
    { k: 'line', w: 82 },
    { k: 'gap' },
    { k: 'box' },
    { k: 'gap' },
    { k: 'h', w: 36 },
    { k: 'line', w: 90 },
  ],
  report: [
    { k: 'title', w: 66 },
    { k: 'sub', w: 40 },
    { k: 'gap' },
    { k: 'h', w: 28 },
    { k: 'line', w: 100 },
    { k: 'line', w: 88 },
    { k: 'gap' },
    { k: 'table' },
    { k: 'gap' },
    { k: 'line', w: 94 },
  ],
  letter: [
    { k: 'right', w: 38 },
    { k: 'gap' },
    { k: 'line', w: 34 },
    { k: 'line', w: 48 },
    { k: 'gap' },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 100 },
    { k: 'line', w: 92 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 64 },
  ],
}

export function PageSketch({ sketch }: { sketch: Template['sketch'] }) {
  return (
    <div className="sketch" aria-hidden="true">
      {SKETCHES[sketch].map((stroke, index) => (
        <i
          key={index}
          className={`sk sk-${stroke.k}`}
          style={stroke.w ? { width: `${stroke.w}%` } : undefined}
        />
      ))}
    </div>
  )
}

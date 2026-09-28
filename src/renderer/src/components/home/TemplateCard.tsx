import { type Template } from '../../templates'
import { PlusIcon } from '../ui/Icons'

export function TemplateCard({ template, onClick }: { template: Template; onClick: () => void }) {
  const blank = template.id === 'blank'
  return (
    <div className="template">
      <button
        type="button"
        className={`template-card${blank ? ' blank' : ''}`}
        data-testid={blank ? 'new-doc' : `template-${template.id}`}
        aria-label={blank ? 'Blank document' : `${template.title} template`}
        onClick={onClick}
      >
        {blank ? <PlusIcon /> : <PageSketch sketch={template.sketch} />}
      </button>
      <span className="template-title">{blank ? 'Blank document' : template.title}</span>
      {template.category ? <span className="template-category">{template.category}</span> : null}
    </div>
  )
}

const PREVIEWS = {
  blank: { title: '', subtitle: '', sections: [] },
  essay: {
    title: 'The shape of an idea',
    subtitle: 'An essay outline',
    sections: ['Introduction', 'Developing the argument', 'A different perspective', 'Conclusion'],
  },
  notes: {
    title: 'Lecture notes',
    subtitle: 'Subject · Topic · Date',
    sections: ['Key ideas', 'From the discussion', 'Examples & connections', 'Questions to revisit'],
  },
  guide: {
    title: 'Study guide',
    subtitle: 'A little clarity, one concept at a time.',
    sections: ['The essentials', 'Key terms', 'Put it into practice', 'Check your understanding'],
  },
  report: {
    title: 'Lab report',
    subtitle: 'Observations & findings',
    sections: ['Objective', 'Materials and methods', 'Results', 'Discussion'],
  },
  letter: {
    title: 'Your name',
    subtitle: 'Address · City · Contact',
    sections: ['Dear recipient,', 'A clear opening', 'The details', 'Sincerely,'],
  },
}

export function PageSketch({ sketch }: { sketch: Template['sketch'] }) {
  const preview = PREVIEWS[sketch]
  return (
    <div className={`template-page template-page-${sketch}`} aria-hidden="true">
      <strong>{preview.title}</strong>
      <small>{preview.subtitle}</small>
      {preview.sections.map((heading) => (
        <section key={heading}>
          <h3>{heading}</h3>
          <p>
            Begin with the main idea. Bring together the details, observations, and examples that help explain it
            clearly.
          </p>
          <p>Make room for a useful connection and a question to explore.</p>
        </section>
      ))}
    </div>
  )
}

import * as Cause from 'effect/Cause'
import type * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

/** One "Unhandled defect" line, as `reportDefect` writes it. */
export interface ReportedDefect {
  readonly reportId: unknown
  /** The `observed` name the defect was reported under, if any. */
  readonly where: unknown
  /** The defects in full (`Cause.pretty`). */
  readonly message: string
}

/**
 * A logger that keeps every defect report, for tests that make work die on
 * purpose. Assert exactly one report with the expected `where`: that catches
 * both a silent defect and one reported twice.
 */
export const captureDefects = (): {
  readonly layer: Layer.Layer<never>
  readonly reported: () => ReadonlyArray<ReportedDefect>
} => {
  const reports: ReportedDefect[] = []
  const capture = Logger.make(({ cause, fiber, message }) => {
    const text = Array.isArray(message) ? message[0] : message
    if (text !== 'Unhandled defect') return
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    reports.push({ reportId: annotations.reportId, where: annotations.where, message: Cause.pretty(cause) })
  })
  return { layer: Logger.layer([capture]), reported: () => [...reports] }
}

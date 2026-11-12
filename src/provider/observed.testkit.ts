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

/** One warning line, with its annotations. */
export interface Warning {
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/**
 * A logger that keeps every defect report and warning, for tests that make
 * work fail on purpose. Assert exactly one report with the expected `where`:
 * that catches both a silent defect and one reported twice.
 */
export const captureReports = (): {
  readonly layer: Layer.Layer<never>
  readonly reported: () => ReadonlyArray<ReportedDefect>
  readonly warned: () => ReadonlyArray<Warning>
} => {
  const reports: ReportedDefect[] = []
  const warnings: Warning[] = []
  const capture = Logger.make(({ cause, fiber, logLevel, message }) => {
    const text = Array.isArray(message) ? message[0] : message
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    if (logLevel === 'Warn') warnings.push({ message: text, annotations })
    if (text !== 'Unhandled defect') return
    reports.push({ reportId: annotations.reportId, where: annotations.where, message: Cause.pretty(cause) })
  })
  return { layer: Logger.layer([capture]), reported: () => [...reports], warned: () => [...warnings] }
}

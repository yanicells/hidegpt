/*
 * Adapted from T3 Code (apps/web/src/components/RenderErrorBoundary.tsx) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */
import { Component, type ReactNode } from 'react'

interface RenderErrorBoundaryProps {
  readonly children: ReactNode
  readonly fallback: ReactNode
  /** A change in any key clears the failure and renders the children again. */
  readonly resetKeys?: ReadonlyArray<unknown>
}

interface RenderErrorBoundaryState {
  readonly failed: boolean
  readonly resetKeys?: ReadonlyArray<unknown> | undefined
}

/** Shows `fallback` instead of a subtree that threw while rendering, so the rest of the window keeps working. */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  override state: RenderErrorBoundaryState = { failed: false, resetKeys: this.props.resetKeys }

  static getDerivedStateFromProps({ resetKeys }: RenderErrorBoundaryProps, state: RenderErrorBoundaryState) {
    if (
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, index) => !Object.is(key, state.resetKeys?.[index]))
    ) {
      return { failed: false, resetKeys }
    }
    return null
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * React's `onCaughtError` for the root: one short line per error a boundary
 * caught, with only its name and a capped message, never the document text
 * it was rendering. React's default would log the whole error and stack.
 */
// TODO: send this to main's defect log once Package A's reporting is on this branch.
export function reportRenderError(error: unknown): void {
  const { name, message } = error instanceof Error ? error : { name: typeof error, message: String(error) }
  console.error('render error', name, message.slice(0, 200))
}

/** Stands in for one block on the page that couldn't render. */
export function BlockFallback() {
  return (
    <p className="render-error" role="note" data-testid="block-error">
      This part of the document couldn't be displayed.
    </p>
  )
}

/** The whole window, when the app itself couldn't render. Reloading resyncs from main. */
export function PageFallback() {
  return (
    <div className="page-error" role="alert">
      <h1>Something went wrong</h1>
      <p>Docs couldn't display this page. Reload to keep working.</p>
      <button type="button" className="outlined-button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  )
}

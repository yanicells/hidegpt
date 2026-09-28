import { useState } from 'react'
import { PROVIDERS, providerLabel } from '../../../../codex/labels'
import type { Snapshot } from '../../../../codex/types'

export function ProviderSwitch({ provider }: { provider: Snapshot['provider'] }) {
  const [pending, setPending] = useState<Snapshot['provider'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const switchTo = async (next: Snapshot['provider']) => {
    if (next === provider || pending) return
    setPending(next)
    setError(null)
    try {
      await window.hidegpt.dispatch({ op: 'setProvider', provider: next, home: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open this library. Try again.')
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <div
        className="flex shrink-0 items-center gap-1 rounded-full bg-[#edf2fa] p-1"
        role="group"
        aria-label="Document library"
      >
        {PROVIDERS.map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`library-${value}`}
            aria-pressed={provider === value}
            disabled={!!pending}
            onClick={() => void switchTo(value)}
            title={`Open ${providerLabel(value)} documents and projects`}
            className={`rounded-full px-3 py-2 text-sm transition-colors disabled:opacity-50 ${provider === value ? 'bg-white text-[#1967d2] shadow-sm' : 'text-[#5f6368] hover:bg-white/60'}`}
          >
            {providerLabel(value)}
          </button>
        ))}
      </div>
      {pending && (
        <div
          className="fixed inset-x-0 bottom-0 top-[72px] z-50 grid place-content-center bg-white/95 text-center"
          role="status"
          aria-live="polite"
        >
          <span className="mx-auto mb-4 size-6 animate-spin rounded-full border-2 border-solid border-[#d3e3fd] border-t-[#1a73e8]" />
          Opening {providerLabel(pending)} library…
          <small className="mt-2 text-[#5f6368]">Loading documents and project folders</small>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="fixed right-4 top-20 z-50 max-w-sm rounded-xl border border-red-200 bg-white p-4 shadow-lg"
        >
          {error}
          <button className="ml-3 text-[#1967d2]" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}

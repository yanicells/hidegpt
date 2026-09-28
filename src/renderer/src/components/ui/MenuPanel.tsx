import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

export type Item = { id: string; label: string; run: () => void; disabled?: boolean; checked?: boolean }

export type MenuId =
  | 'file'
  | 'edit'
  | 'view'
  | 'insert'
  | 'tools'
  | 'account'
  | 'model'
  | 'effort'
  | 'serviceTier'
  | 'mode'
  | 'provider'
  | null

export function MenuPanel({
  items,
  onClose,
  testId,
  align = 'start',
  itemPrefix = 'action',
  children,
}: {
  items: Item[]
  onClose: () => void
  testId?: string
  align?: 'start' | 'end'
  itemPrefix?: string
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    )
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div
      ref={ref}
      className={`menu-panel align-${align}`}
      role="menu"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {children}
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`menu-item${item.checked ? ' checked' : ''}`}
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          data-testid={`${itemPrefix}-${item.id}`}
          disabled={item.disabled}
          onClick={() => {
            item.run()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function useDismiss(active: boolean, onClose: () => void, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!active) return
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, onClose, ref])
}

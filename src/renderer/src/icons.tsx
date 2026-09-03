export function DocsIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M8 2h22l12 12v32H8z" />
      <path fill="#A1C2FA" d="M30 2v12h12" />
      <path fill="#fff" d="M14 22h20v2.4H14zm0 6.2h20v2.4H14zm0 6.2h14v2.4H14z" />
    </svg>
  )
}

export function DocsMark({ size = 24 }: { size?: number }) {
  return <DocsIcon size={size} />
}

export function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"
      />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <path fill="#4285F4" d="M18 22H8v-4h10V8h4v10h10v4H22v10h-4z" />
      <path fill="#0F9D58" d="M22 22v10h-4V22z" />
      <path fill="#F4B400" d="M22 18h10v4H22z" />
      <path fill="#DB4437" d="M18 8h4v10h-4z" />
    </svg>
  )
}

export function GridIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" />
    </svg>
  )
}

export function ListIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z" />
    </svg>
  )
}

export function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M7 10l5 5 5-5z" />
    </svg>
  )
}

export function PenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"
      />
    </svg>
  )
}

export function CloudIcon({ busy }: { busy: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={busy ? 'cloud busy' : 'cloud'}>
      <path
        fill="currentColor"
        d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96"
      />
      {busy ? (
        <path fill="#fff" d="M12 9v2.5l2.2 1.3-.7 1.2L10.5 12V9z" />
      ) : (
        <path fill="#fff" d="M10 16.2 7.3 13.5l1.1-1.1 1.6 1.6 4.6-4.6 1.1 1.1z" />
      )}
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" />
    </svg>
  )
}

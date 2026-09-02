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
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M8 2h22l12 12v32H8z" />
      <path fill="#A1C2FA" d="M30 2v12h12" />
      <path fill="#fff" d="M14 22h20v2.4H14zm0 6.2h20v2.4H14zm0 6.2h14v2.4H14z" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#5f6368"
        d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"
      />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1a73e8" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
    </svg>
  )
}

export function GridIcon({ active }: { active?: boolean }) {
  const fill = active ? '#1a73e8' : '#5f6368'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill={fill}
        d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"
      />
    </svg>
  )
}

export function ListIcon({ active }: { active?: boolean }) {
  const fill = active ? '#1a73e8' : '#5f6368'
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill={fill} d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z" />
    </svg>
  )
}

export function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#5f6368" d="M7 10l5 5 5-5z" />
    </svg>
  )
}

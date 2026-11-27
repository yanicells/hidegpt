/**
 * Google product marks drawn by the Docs chrome (logo, file-type badge, the
 * blank-document plus, side-panel app icons, the sparks). Everything else is a
 * Material Symbol: see MaterialIcon.tsx.
 */

import { useId } from 'react'

/** The Docs app logo: a blue page with a folded corner and two text lines. */
export function DocsIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path fill="#4285F4" d="M11 3h13l9 9v23a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" />
      <path fill="#A1C2FA" d="M24 3v6a3 3 0 0 0 3 3h6z" />
      <rect x="13" y="22" width="14" height="2.6" rx="1.3" fill="#fff" />
      <rect x="13" y="27.5" width="9" height="2.6" rx="1.3" fill="#fff" />
    </svg>
  )
}

/** The small blue Docs file-type badge used in card footers and list rows. */
export function DocFileIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2" y="2" width="16" height="16" rx="2.5" fill="#4285F4" />
      <rect x="5.5" y="8.2" width="9" height="1.7" rx=".85" fill="#fff" />
      <rect x="5.5" y="11.4" width="6" height="1.7" rx=".85" fill="#fff" />
    </svg>
  )
}

/** The four-colour plus on the "Blank document" template tile. */
export function PlusIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <path fill="#EA4335" d="M17 6h6v11h-6z" />
      <path fill="#4285F4" d="M23 17h11v6H23z" />
      <path fill="#34A853" d="M17 23h6v11h-6z" />
      <path fill="#FBBC04" d="M6 17h11v6H6z" />
      <path fill="#4285F4" d="M17 17h6v6h-6z" />
    </svg>
  )
}

const SPARK = 'M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z'

/**
 * Gemini's four-colour spark beside Share: blue, washed red from the top,
 * yellow from the left and green from the bottom. `mono` draws the plain
 * text-coloured spark of the floating pill.
 */
export function SparkIcon({ size = 24, mono = false }: { size?: number; mono?: boolean }) {
  // Unique per instance: a hidden copy's defs would otherwise blank the others.
  const id = useId()
  if (mono) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={SPARK} />
      </svg>
    )
  }
  const glows = [
    { key: 'red', color: '#EA4335', cx: 12, cy: 2 },
    { key: 'yellow', color: '#FBBC04', cx: 2, cy: 12 },
    { key: 'green', color: '#34A853', cx: 12, cy: 22 },
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <clipPath id={`${id}-clip`}>
          <path d={SPARK} />
        </clipPath>
        {glows.map((glow) => (
          <radialGradient
            key={glow.key}
            id={`${id}-${glow.key}`}
            cx={glow.cx}
            cy={glow.cy}
            r="10"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset=".35" stopColor={glow.color} />
            <stop offset="1" stopColor={glow.color} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="24" height="24" fill="#3186FF" />
        {glows.map((glow) => (
          <rect key={glow.key} width="24" height="24" fill={`url(#${id}-${glow.key})`} />
        ))}
      </g>
    </svg>
  )
}

/** The toolbar's play-in-a-circle with a spark in the ring's gap (left of the pencil). */
export function PlaySparkIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M14.07 4.27A8 8 0 1 0 19.73 9.93"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M10 8.5v7l5.5-3.5z" />
      <path d="M18.5 1.5c.3 1.8 1.7 3.2 3.5 3.5-1.8.3-3.2 1.7-3.5 3.5-.3-1.8-1.7-3.2-3.5-3.5 1.8-.3 3.2-1.7 3.5-3.5z" />
    </svg>
  )
}

/** Side-panel app icons (Calendar, Keep, Tasks, Contacts, Maps). */
export function RailIcon({ app }: { app: 'calendar' | 'keep' | 'tasks' | 'contacts' | 'maps' }) {
  switch (app) {
    case 'calendar':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="2" width="16" height="16" rx="3" fill="#4285F4" />
          <path fill="#8AB4F8" d="M5 2h10a3 3 0 0 1 3 3v.5H2V5a3 3 0 0 1 3-3z" />
          <text
            x="10"
            y="14.6"
            textAnchor="middle"
            fontFamily="Roboto, Arial"
            fontSize="9"
            fontWeight="700"
            fill="#fff"
          >
            31
          </text>
        </svg>
      )
    case 'keep':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path fill="#FBBC04" d="M10 2a6 6 0 0 0-3.5 10.9V15h7v-2.1A6 6 0 0 0 10 2z" />
          <path fill="#F29900" d="M7 16h6v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z" />
          <path fill="#fff" d="M9.2 9h1.6v5H9.2z" />
        </svg>
      )
    case 'tasks':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8" fill="#4285F4" />
          <path fill="#fff" d="m8.6 13.6-3.2-3.2 1.2-1.2 2 2 4.8-4.8 1.2 1.2z" />
        </svg>
      )
    case 'contacts':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="6.5" r="3.5" fill="#1A73E8" />
          <path fill="#1A73E8" d="M3.5 16.5c0-3 3-4.8 6.5-4.8s6.5 1.8 6.5 4.8v.5h-13z" />
        </svg>
      )
    case 'maps':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path fill="#34A853" d="M10 18s-5.5-5.8-5.5-10a5.5 5.5 0 0 1 2-4.3L10 9z" />
          <path fill="#FBBC04" d="M10 18 10 9l4.8-3.5c.5.8.7 1.6.7 2.5 0 4.2-5.5 10-5.5 10z" />
          <path fill="#4285F4" d="M14.8 5.5 10 9 6.5 3.7A5.5 5.5 0 0 1 14.8 5.5z" />
          <path fill="#EA4335" d="M6.5 3.7 10 9 4.5 8a5.5 5.5 0 0 1 2-4.3z" />
          <circle cx="10" cy="7.8" r="2" fill="#fff" />
        </svg>
      )
  }
}

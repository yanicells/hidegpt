/**
 * Google product marks drawn by the Docs chrome (logo, file-type badge, the
 * blank-document plus, side-panel app icons, the sparks, the Home quick-launch
 * products). Everything else is a Material Symbol: see MaterialIcon.tsx.
 *
 * The marks were traced against the references at 2x. Shading uses a few SVG
 * gradients and soft "halo" copies (a slightly larger, faint shape behind the
 * mark) instead of filters, so they cost next to nothing to paint. Gradient and
 * clip ids come from useId: a hidden copy's defs would otherwise blank the others.
 */

import { useId } from 'react'

const DOCS_BODY =
  'M3.75 0H12.75L24 11.25V28.25A3.75 3.75 0 0 1 20.25 32H3.75A3.75 3.75 0 0 1 0 28.25V3.75A3.75 3.75 0 0 1 3.75 0Z'

/**
 * The Docs logo: a blue page with a pink wash from the bottom left, a light
 * folded corner and two text lines. `size` is the height; the width defaults
 * to the logo's 3:4. The editor header draws 24x32 (`size={32}`), Home 27x37
 * (`size={37} width={27}`).
 */
export function DocsIcon({ size = 32, width = size * 0.75 }: { size?: number; width?: number }) {
  const id = useId()
  return (
    <svg width={width} height={size} viewBox="0 0 24 32" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <radialGradient
          id={`${id}-wash`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(9 43.6) scale(20.4 28.4)"
        >
          <stop offset="0" stopColor="#ffc1fc" />
          <stop offset="1" stopColor="#ffc1fc" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={DOCS_BODY} fill="#3186ff" />
      <path d={DOCS_BODY} fill={`url(#${id}-wash)`} />
      <path d="M12.75 0V7.75A2 2 0 0 0 14.75 9.75H22.5Z" fill="#77bbff" />
      <rect x="6.05" y="19.3" width="11.9" height="2.1" rx="1.05" fill="#fff" />
      <rect x="6.05" y="24.55" width="8.85" height="2.1" rx="1.05" fill="#fff" />
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

/** The four-colour plus on the "Blank document" template tile (48x48 ink by default). */
export function PlusIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#ea4335" d="M20 0h8v20L20 28z" />
      <path fill="#4285f4" d="M28 20h20v8H20z" />
      <path fill="#fbbc05" d="M0 20h20v8H0z" />
      <path fill="#34a853" d="M20 28h8v20h-8z" />
    </svg>
  )
}

const SPARK = 'M12 2C15 8 16 9 22 12C16 15 15 16 12 22C9 16 8 15 2 12C8 9 9 8 12 2Z'

// Each glow is solid colour out to `solid`, fading to clear at `r`, painted in order over the blue.
const SPARK_GLOWS = [
  { key: 'red', color: '#e25f69', cx: -0.28, cy: -6, r: 20.48, solid: 0.8 },
  { key: 'yellow', color: '#e6cd2e', cx: -6, cy: 16.54, r: 18.4, solid: 0.66 },
  { key: 'green', color: '#2ae513', cx: 7.83, cy: 23.68, r: 12.2, solid: 0 },
]

/**
 * Gemini's four-colour spark beside Share: blue, with red from the top left,
 * yellow from the left and green from the bottom. `mono` draws the plain
 * text-coloured spark of the floating pill. The header draws it at `size={24}`
 * (20px of ink).
 */
export function SparkIcon({ size = 24, mono = false }: { size?: number; mono?: boolean }) {
  const id = useId()
  if (mono) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={SPARK} />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <clipPath id={`${id}-clip`}>
          <path d={SPARK} />
        </clipPath>
        {SPARK_GLOWS.map((glow) => (
          <radialGradient
            key={glow.key}
            id={`${id}-${glow.key}`}
            cx={glow.cx}
            cy={glow.cy}
            r={glow.r}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset={glow.solid} stopColor={glow.color} />
            <stop offset="1" stopColor={glow.color} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="24" height="24" fill="#388bf9" />
        {SPARK_GLOWS.map((glow) => (
          <rect key={glow.key} width="24" height="24" fill={`url(#${id}-${glow.key})`} />
        ))}
      </g>
    </svg>
  )
}

/** The toolbar's play-in-a-circle with a spark in the ring's gap (left of the pencil). */
export function PlaySparkIcon({ size = 21 }: { size?: number }) {
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

/** Gradient stops as [offset, colour] pairs. */
function Stops({ stops }: { stops: [number, string][] }) {
  return stops.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)
}

// Maps' pin is ringed with a conic sweep, which SVG lacks: 36 overlapping 10° wedges
// around the pin's head, clockwise from 12 o'clock, clipped to the pin.
const MAPS_SWEEP =
  '5585f5 4787fa 3c8afb 348df6 2c91f0 2198df 16a0cd 11a8b3 0db099 0fb487 11b876 12ba6c 12ba6b 13bb6a 13bb68 13bb67 13bb66 14bc64 14bc63 2dc05b 64c94b 9cd13b ccd12a ecc321 f9a620 fd8527 fc6132 fb553a f94d44 f44e59 ee5170 e25b8f ca67b1 a474d9 7f7ee9 6484ef'.split(
    ' ',
  )
const MAPS_WEDGES = MAPS_SWEEP.map((hex, i) => {
  const point = (deg: number) => {
    const a = (deg * Math.PI) / 180
    return `${(12 + 14 * Math.sin(a)).toFixed(2)} ${(10.91 - 14 * Math.cos(a)).toFixed(2)}`
  }
  return { fill: `#${hex}`, d: `M12 10.91L${point(i * 10 - 0.6)}L${point(i * 10 + 10.6)}Z` }
})

/**
 * Side-panel app icons (Calendar, Keep, Tasks, Contacts, Maps), drawn in a 24x24
 * box meant to sit centred in the 40px rail button.
 */
export function RailIcon({ app }: { app: 'calendar' | 'keep' | 'tasks' | 'contacts' | 'maps' }) {
  const id = useId()
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {app === 'calendar' && (
        <>
          <defs>
            <linearGradient id={`${id}-g`} gradientUnits="userSpaceOnUse" x1="0" y1="4.92" x2="0" y2="20.93">
              <Stops
                stops={[
                  [0.03, '#a1adf9'],
                  [0.16, '#82a0fe'],
                  [0.34, '#4e93fc'],
                  [0.42, '#4091fe'],
                  [0.56, '#4a9afd'],
                  [0.75, '#4093fc'],
                  [0.92, '#388afd'],
                ]}
              />
            </linearGradient>
          </defs>
          <rect x="4.98" y="3.87" width="13.97" height="4.36" rx="2.24" fill="#cbebff" />
          <path
            d="M6.63 4.92H17.39A2.57 2.57 0 0 1 19.96 7.48Q19.07 12.92 19.96 18.36A2.57 2.57 0 0 1 17.39 20.93H6.63A2.57 2.57 0 0 1 4.06 18.36Q4.95 12.92 4.06 7.48A2.57 2.57 0 0 1 6.63 4.92Z"
            fill={`url(#${id}-g)`}
          />
          {/* A hand-drawn "31". */}
          <g
            fill="none"
            stroke="#fff"
            strokeWidth="1.14"
            strokeLinecap="round"
            strokeLinejoin="round"
            transform="translate(12 12.98) scale(0.97) translate(-12 -12.8)"
          >
            <path
              transform="translate(0.04 0)"
              d="M8.3 10.3C8.6 9.5 9.2 9.1 9.9 9.1 10.8 9.1 11.4 9.7 11.4 10.6 11.4 11.6 10.7 12.4 9.6 12.4 10.8 12.4 11.5 13.2 11.5 14.4 11.5 15.6 10.8 16.4 9.8 16.4 9.1 16.4 8.5 16 8.2 15.3"
            />
            <path transform="translate(-0.24 0)" d="M14 10.6 15.9 9.2V16.6" />
          </g>
        </>
      )}
      {app === 'keep' && (
        <>
          <defs>
            <linearGradient id={`${id}-y`} gradientUnits="userSpaceOnUse" x1="0" y1="4.07" x2="0" y2="14.7">
              <Stops
                stops={[
                  [0, '#fec30c'],
                  [0.5, '#fed618'],
                  [1, '#ffec44'],
                ]}
              />
            </linearGradient>
            <radialGradient id={`${id}-p`} gradientUnits="userSpaceOnUse" cx="12.03" cy="15.52" r="5.57">
              <stop offset="0.067" stopColor="#fff" />
              <stop offset="0.366" stopColor="#fbc4d6" />
              <stop offset="1" stopColor="#fbc4d6" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="12.03" cy="11.16" rx="7.61" ry="7.7" fill="#fdd21c" opacity="0.31" />
          <ellipse cx="12.03" cy="11.16" rx="7.08" ry="7.17" fill={`url(#${id}-y)`} />
          <ellipse cx="12.03" cy="11.16" rx="7.08" ry="7.17" fill={`url(#${id}-p)`} />
          <path d="M8.75 17.7H15.29V19.04A3.27 3.27 0 0 1 8.75 19.04Z" fill="#f5a000" />
        </>
      )}
      {app === 'tasks' && (
        <>
          <defs>
            <linearGradient id={`${id}-t`} gradientUnits="userSpaceOnUse" x1="0" y1="11.5" x2="0" y2="20.5">
              <Stops
                stops={[
                  [0, '#3186ff'],
                  [1, '#9ea8fd'],
                ]}
              />
            </linearGradient>
          </defs>
          <ellipse cx="11.75" cy="13.63" rx="8.22" ry="8.78" fill="#cbe8fb" />
          <ellipse cx="12" cy="12.48" rx="9.04" ry="8.28" fill={`url(#${id}-t)`} />
          <path
            d="M8.11 12.16 10.94 14.96 16.27 9.67"
            fill="none"
            stroke="#fff"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {app === 'contacts' && (
        <>
          <defs>
            <linearGradient id={`${id}-b`} gradientUnits="userSpaceOnUse" x1="5.21" y1="0" x2="18.84" y2="0">
              <Stops
                stops={[
                  [0, '#9eb6f8'],
                  [1, '#5a8cfb'],
                ]}
              />
            </linearGradient>
          </defs>
          <rect x="4.96" y="12.55" width="14.13" height="8.52" rx="3.5" fill="#6f98f6" opacity="0.31" />
          <circle cx="12" cy="7.9" r="3.4" fill="#0057cc" opacity="0.31" />
          <rect x="5.21" y="12.8" width="13.63" height="8.02" rx="3.25" fill={`url(#${id}-b)`} />
          <path
            d="M8.04 20.81V15.15A2.44 2.44 0 0 1 10.48 12.71H13.3A2.44 2.44 0 0 1 15.74 15.15V20.81Z"
            fill="#0057cc"
          />
          <circle cx="12" cy="7.9" r="3.15" fill="#0057cc" />
        </>
      )}
      {app === 'maps' && (
        <>
          <defs>
            <clipPath id={`${id}-pin`}>
              <path d="M12 21.71C10.83 20.99 4.88 14.93 4.88 10.91A7.12 7.12 0 0 1 19.12 10.91C19.12 14.93 13.17 20.99 12 21.71Z" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${id}-pin)`}>
            {MAPS_WEDGES.map((wedge) => (
              <path key={wedge.fill + wedge.d} d={wedge.d} fill={wedge.fill} />
            ))}
          </g>
          <circle cx="11.96" cy="11.02" r="3.86" fill="#fff" />
        </>
      )}
    </svg>
  )
}

export type Product = 'sheets' | 'slides' | 'vids' | 'forms'

/**
 * The Home quick-launch pill's product icons (Sheets, Slides, Vids, Forms), 24x24.
 * @public Used by the Home header's quick-launch pill (UI-12).
 */
export function ProductIcon({ product }: { product: Product }) {
  const id = useId()
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {product === 'sheets' && (
        <>
          <defs>
            <linearGradient id={`${id}-s`} gradientUnits="userSpaceOnUse" x1="7.93" y1="0" x2="19.82" y2="0">
              <Stops
                stops={[
                  [0, '#10bc5f'],
                  [1, '#74c9f8'],
                ]}
              />
            </linearGradient>
          </defs>
          <rect x="-0.15" y="2.86" width="24.27" height="18.25" rx="3.37" fill="#e3f9f5" />
          <rect x="19.99" y="6.06" width="2.97" height="12.01" rx="1" fill="#05945e" />
          <rect x="1" y="4.01" width="19.83" height="15.95" rx="2.22" fill="#1db464" />
          <rect x="2" y="5.01" width="18.83" height="13.95" rx="1.22" fill={`url(#${id}-s)`} />
          <rect x="3.01" y="8.02" width="11.65" height="1.65" fill="#fff" opacity=".82" />
          <rect x="4.96" y="6.07" width="1.93" height="9.09" fill="#fff" opacity=".7" />
        </>
      )}
      {product === 'slides' && (
        <>
          <defs>
            <linearGradient id={`${id}-o`} gradientUnits="userSpaceOnUse" x1="3.16" y1="0" x2="19.56" y2="0">
              <Stops
                stops={[
                  [0, '#f5bb1c'],
                  [0.5, '#f7bd6e'],
                  [1, '#f4d3db'],
                ]}
              />
            </linearGradient>
            <linearGradient id={`${id}-y`} gradientUnits="userSpaceOnUse" x1="0" y1="2.1" x2="0" y2="19.91">
              <Stops
                stops={[
                  [0.12, '#fbbf00'],
                  [0.45, '#fec305'],
                  [0.65, '#ffca10'],
                  [0.88, '#fedf2d'],
                  [1, '#ffed52'],
                ]}
              />
            </linearGradient>
          </defs>
          <path
            d="M1.14 6.41Q1.14 3.28 4.28 2.97Q12.01 1.37 16.58 1.75Q22.88 1.13 22.88 7.43V17.74Q22.88 20.88 19.74 20.88H4.22Q1.09 20.88 1.09 17.74Z"
            fill="#f7f4e1"
          />
          <path d="M3.16 18.91H19.56L19.7 20.25L6.16 22.16Z" fill={`url(#${id}-o)`} />
          <path
            d="M2.11 6.41Q2.11 4.24 4.28 4.01Q12.01 2.34 16.58 2.68Q21.91 2.1 21.91 7.43V17.74Q21.91 19.91 19.74 19.91H4.22Q2.05 19.91 2.05 17.74Z"
            fill={`url(#${id}-y)`}
          />
          <rect
            x="5.71"
            y="8.32"
            width="12.63"
            height="7.39"
            fill="none"
            stroke="#ffffdc"
            strokeWidth="2.46"
            opacity="0.22"
          />
          <rect x="5.71" y="8.32" width="12.63" height="7.39" fill="none" stroke="#ffffdc" strokeWidth="1.39" />
        </>
      )}
      {product === 'vids' && (
        <>
          <defs>
            <linearGradient id={`${id}-v`} gradientUnits="userSpaceOnUse" x1="6.84" y1="0" x2="21.21" y2="0">
              <Stops
                stops={[
                  [0, '#5fa6fb'],
                  [0.45, '#6d82fc'],
                  [1, '#7473fd'],
                ]}
              />
            </linearGradient>
            <linearGradient id={`${id}-b`} gradientUnits="userSpaceOnUse" x1="2.52" y1="0" x2="6.84" y2="0">
              <Stops
                stops={[
                  [0, '#d9def9'],
                  [1, '#b3bbf8'],
                ]}
              />
            </linearGradient>
          </defs>
          <rect x="2.52" y="5.13" width="7" height="13.7" rx="3.07" fill={`url(#${id}-b)`} />
          <rect x="6.84" y="2.05" width="14.37" height="19.8" rx="3.43" fill={`url(#${id}-v)`} />
          <path d="M12.1 9.1V14.95L17.28 12.02Z" fill="#fff" stroke="#fff" strokeWidth="0.57" strokeLinejoin="round" />
        </>
      )}
      {product === 'forms' && (
        <>
          <defs>
            <linearGradient id={`${id}-f`} gradientUnits="userSpaceOnUse" x1="8.57" y1="0" x2="14.98" y2="0">
              <Stops
                stops={[
                  [0, '#60a0fa'],
                  [1, '#7473fb'],
                ]}
              />
            </linearGradient>
          </defs>
          <circle cx="5.5" cy="5.98" r="3" fill="#6d6cf6" />
          <rect x="8.57" y="2.88" width="12.82" height="6.21" rx="3.1" fill={`url(#${id}-f)`} />
          <circle cx="5.5" cy="5.98" r="1.51" fill="#fff" />
          <rect x="11.01" y="5.01" width="7.93" height="1.99" rx="1" fill="#fff" />
          <circle cx="5.5" cy="12" r="3" fill="#5848e4" />
          <rect x="8.57" y="8.9" width="12.82" height="6.21" rx="3.1" fill="#5848e4" />
          <rect x="5.5" y="11" width="4.07" height="2" fill="#5848e4" />
          <circle cx="5.5" cy="18.04" r="3" fill="#b9c0f8" />
          <rect x="8.57" y="14.94" width="12.82" height="6.21" rx="3.1" fill="#9aa0f6" />
        </>
      )}
    </svg>
  )
}

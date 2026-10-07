import React from 'react'

/** BLF-1244 用户选定的 B · 飞翼，保持原始 SVG 造型与配色。 */
export function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="32" fill="#2755d9" />
      <g fill="#fff">
        <path d="M15 16H29L49 28H35Z" />
        <path d="M15 28H29L49 40H35Z" />
        <path d="M15 40H29L42 48H28Z" />
      </g>
    </svg>
  )
}

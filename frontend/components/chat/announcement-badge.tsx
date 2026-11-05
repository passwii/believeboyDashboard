'use client'

import { Bolt } from 'lucide-react'
import styles from './warm-chat.module.css'

export function AnnouncementBadge({ text, href = '#' }: { text: string; href?: string }) {
  const content = (
    <>
      <Bolt className="size-4 relative z-10" aria-hidden />
      <span className="relative z-10 font-medium">{text}</span>
    </>
  )

  const baseClass = `${styles.announcement} ${styles.chip} relative inline-flex items-center gap-2 px-5 py-2 overflow-hidden text-sm transition-all duration-[var(--duration-quick)] hover:scale-[1.02] active:scale-[0.98] cursor-pointer bb-anim-scale-in`

  return (
    <>
      {href !== '#' ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={baseClass} style={{ animationDelay: '0.2s' }}>
          {content}
        </a>
      ) : (
        <button type="button" className={baseClass} style={{ animationDelay: '0.2s' }}>
          {content}
        </button>
      )}
    </>
  )
}

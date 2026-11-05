'use client'

import * as React from 'react'
import { X } from 'lucide-react'

import { WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'

import styles from '../profile-warm.module.css'

interface ProfileAvatarPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  avatarUrl: string | null
  name: string
}

export function ProfileAvatarPreviewDialog({
  open,
  onOpenChange,
  avatarUrl,
  name,
}: ProfileAvatarPreviewDialogProps) {
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  if (!open || !avatarUrl) return null

  return (
    <div
      className={styles.previewOverlay}
      role="presentation"
      onClick={() => onOpenChange(false)}
    >
      <div
        className={styles.previewFrame}
        role="dialog"
        aria-modal="true"
        aria-label={`头像预览 — ${name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <WarmIconButton
          aria-label="关闭头像预览"
          className={styles.previewClose}
          onClick={() => onOpenChange(false)}
        >
          <X aria-hidden="true" />
        </WarmIconButton>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl} alt={`${name} 头像原图`} className={styles.previewImage} />
      </div>
    </div>
  )
}

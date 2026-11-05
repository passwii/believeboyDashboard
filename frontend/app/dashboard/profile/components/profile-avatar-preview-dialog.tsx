'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'

import styles from '../profile-warm.module.css'

interface ProfileAvatarPreviewDialogProps {
  avatarUrl: string | null
  name: string
}

export function ProfileAvatarPreviewDialog({ avatarUrl, name }: ProfileAvatarPreviewDialogProps) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null)

  React.useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  if (!avatarUrl) return null

  return (
    <DialogPrimitive.Portal container={portalContainer}>
      <DialogPrimitive.Overlay className={styles.previewOverlay} />
      <DialogPrimitive.Content className={styles.previewFrame}>
        <DialogPrimitive.Title className={styles.visuallyHidden}>
          头像预览 — {name}
        </DialogPrimitive.Title>
        <DialogPrimitive.Close asChild>
          <WarmIconButton aria-label="关闭头像预览" className={styles.previewClose}>
            <X aria-hidden="true" />
          </WarmIconButton>
        </DialogPrimitive.Close>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl} alt={`${name} 头像原图`} className={styles.previewImage} />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

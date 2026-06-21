'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'

interface ProfileAvatarPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  avatarUrl: string | null
  name: string
}

/**
 * Full-size avatar preview. Triggered by clicking the avatar frame on the
 * profile page; ESC / overlay-click / close button all dismiss.
 */
export function ProfileAvatarPreviewDialog({
  open,
  onOpenChange,
  avatarUrl,
  name,
}: ProfileAvatarPreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl border-0 bg-transparent p-0 shadow-none sm:max-w-3xl">
        <DialogTitle className="sr-only">头像预览 — {name}</DialogTitle>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={`${name} 头像原图`}
            loading="lazy"
            className="mx-auto max-h-[85vh] w-auto rounded-2xl object-contain pb-[env(safe-area-inset-bottom)]"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
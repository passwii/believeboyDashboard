'use client'

import * as React from 'react'
import { Camera } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { type CachedAvatar, loadUserAvatar } from '@/lib/user-avatar-cache'

interface ProfileAvatarDisplayProps {
  userId: string | null
  avatarUrl: string | null
  refreshTick: number
}

export function ProfileAvatarDisplay({ userId, avatarUrl, refreshTick }: ProfileAvatarDisplayProps) {
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null)
  const [previewFromCache, setPreviewFromCache] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let activeUrl: string | null = null

    if (!userId || !avatarUrl) {
      setPreviewSrc(null)
      setPreviewFromCache(false)
      return
    }

    loadUserAvatar(userId, avatarUrl)
      .then((cached: CachedAvatar | null) => {
        if (cancelled || !cached) return
        activeUrl = cached.objectUrl
        setPreviewSrc(cached.objectUrl)
        setPreviewFromCache(cached.fromCache)
      })
      .catch(() => {
        // Failure to decode is non-fatal: avatar component falls back to initials.
      })

    return () => {
      cancelled = true
      if (activeUrl) URL.revokeObjectURL(activeUrl)
    }
  }, [userId, avatarUrl, refreshTick])

  return (
    <div className="flex flex-col items-center gap-3">
      <Avatar className="h-40 w-40 rounded-2xl border border-border/60 shadow-sm">
        {previewSrc ? <AvatarImage src={previewSrc} alt="当前头像" /> : null}
        <AvatarFallback className="rounded-2xl bg-muted text-3xl font-semibold text-muted-foreground">
          <Camera className="h-12 w-12" />
        </AvatarFallback>
      </Avatar>
      <p className="text-xs text-muted-foreground">
        {previewFromCache ? '已从本地缓存加载' : avatarUrl ? '已从 R2 加载' : '尚未上传头像'}
      </p>
    </div>
  )
}
'use client'

import * as React from 'react'
import { Camera } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { type CachedAvatar, loadUserAvatar } from '@/lib/user-avatar-cache'
import { cn } from '@/lib/utils'

import { ProfileAvatarPreviewDialog } from './profile-avatar-preview-dialog'

interface ProfileAvatarDisplayProps {
  userId: string | null
  avatarUrl: string | null
  name: string
  refreshTick: number
}

export function ProfileAvatarDisplay({
  userId,
  avatarUrl,
  name,
  refreshTick,
}: ProfileAvatarDisplayProps) {
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null)
  const [previewFromCache, setPreviewFromCache] = React.useState(false)
  const [zoomedOpen, setZoomedOpen] = React.useState(false)

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

  const hasAvatar = Boolean(previewSrc)
  const label = previewFromCache ? '已从本地缓存加载' : avatarUrl ? '已从 R2 加载' : '尚未上传头像'

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={() => hasAvatar && setZoomedOpen(true)}
        disabled={!hasAvatar}
        aria-label={hasAvatar ? `查看 ${name} 头像原图` : '尚未上传头像'}
        className={cn(
          'group relative rounded-2xl ring-offset-background transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          hasAvatar ? 'cursor-zoom-in hover:ring-4 hover:ring-primary/30' : 'cursor-default'
        )}
      >
        <Avatar className="h-40 w-40 rounded-2xl border border-border/60 shadow-sm transition-shadow group-hover:shadow-md">
          {previewSrc ? <AvatarImage src={previewSrc} alt="当前头像" /> : null}
          <AvatarFallback className="rounded-2xl bg-muted text-3xl font-semibold text-muted-foreground">
            <Camera className="h-12 w-12" />
          </AvatarFallback>
        </Avatar>
        {hasAvatar ? (
          <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/0 text-xs font-medium text-white opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100">
            点击查看原图
          </span>
        ) : null}
      </button>
      <p className="text-xs text-muted-foreground">{label}</p>

      <ProfileAvatarPreviewDialog
        open={zoomedOpen}
        onOpenChange={setZoomedOpen}
        avatarUrl={avatarUrl}
        name={name}
      />
    </div>
  )
}

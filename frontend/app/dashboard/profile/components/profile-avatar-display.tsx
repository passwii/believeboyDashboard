'use client'

import * as React from 'react'
import { Camera } from 'lucide-react'

import { type CachedAvatar, loadUserAvatar } from '@/lib/user-avatar-cache'

import { ProfileAvatarPreviewDialog } from './profile-avatar-preview-dialog'
import styles from '../profile-warm.module.css'

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
        // Decode failures fall back to the camera mark; upload controls remain usable.
      })

    return () => {
      cancelled = true
      if (activeUrl) URL.revokeObjectURL(activeUrl)
    }
  }, [userId, avatarUrl, refreshTick])

  const hasAvatar = Boolean(previewSrc)
  const label = previewFromCache ? '已从本地缓存加载' : avatarUrl ? '已从 R2 加载' : '尚未上传头像'

  return (
    <div className={styles.avatarColumn}>
      <button
        type="button"
        onClick={() => hasAvatar && setZoomedOpen(true)}
        disabled={!hasAvatar}
        aria-label={hasAvatar ? `查看 ${name} 头像原图` : '尚未上传头像'}
        className={styles.avatarFrame}
        data-has-avatar={hasAvatar ? 'true' : 'false'}
      >
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewSrc} alt="当前头像" className={styles.avatarImage} />
        ) : (
          <span className={styles.avatarFallback}>
            <Camera className="h-12 w-12" aria-hidden="true" />
          </span>
        )}
        {hasAvatar ? <span className={styles.avatarHover}>点击查看原图</span> : null}
      </button>
      <p className={styles.avatarLabel}>{label}</p>

      <ProfileAvatarPreviewDialog
        open={zoomedOpen}
        onOpenChange={setZoomedOpen}
        avatarUrl={avatarUrl}
        name={name}
      />
    </div>
  )
}

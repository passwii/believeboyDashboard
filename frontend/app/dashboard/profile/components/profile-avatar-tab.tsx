'use client'

import * as React from 'react'
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { deleteAvatar, uploadAvatar } from '@/lib/client-api/profile-client'
import { invalidateUserAvatar } from '@/lib/user-avatar-cache'
import type { Profile } from '@/types/profile'

import { ProfileAvatarDisplay } from './profile-avatar-display'
import { ProfileAvatarSkeleton } from './profile-skeletons'

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const ACCEPTED_EXT_LABEL = 'PNG / JPG / WEBP / GIF'
const MAX_BYTES = 5 * 1024 * 1024

interface ProfileAvatarTabProps {
  profile: Profile | null
  loading: boolean
  onRefetch: () => Promise<void>
}

export function ProfileAvatarTab({ profile, loading, onRefetch }: ProfileAvatarTabProps) {
  const { notify } = useNotifications()
  const [uploading, setUploading] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [refreshTick, setRefreshTick] = React.useState(0)
  const [confirmRemoveOpen, setConfirmRemoveOpen] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const userId = profile?.id ?? null
  const avatarUrl = profile?.avatar_url ?? null
  const userName = profile?.name ?? '当前用户'

  const onPickFile = () => {
    fileInputRef.current?.click()
  }

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Always reset the input so the same file can be re-picked.
    event.target.value = ''
    if (!file) return

    if (!ACCEPTED_MIME.includes(file.type)) {
      notify({ type: 'error', title: `不支持的文件类型：${file.type || '未知'}` })
      return
    }
    if (file.size > MAX_BYTES) {
      notify({ type: 'error', title: `头像大小不能超过 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB` })
      return
    }

    setUploading(true)
    try {
      await uploadAvatar(file)
      if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
      await onRefetch()
      notify({ type: 'success', title: '头像已更新' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '上传失败') })
    } finally {
      setUploading(false)
    }
  }

  const doRemove = async () => {
    if (!avatarUrl) return
    setRemoving(true)
    try {
      await deleteAvatar()
      if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
      await onRefetch()
      notify({ type: 'success', title: '已恢复默认头像' })
      setConfirmRemoveOpen(false)
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '删除失败') })
    } finally {
      setRemoving(false)
    }
  }

  const onRefresh = () => {
    if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
    setRefreshTick((tick) => tick + 1)
    notify({ type: 'info', title: '正在重新获取头像...' })
  }

  if (loading && !profile) {
    return <ProfileAvatarSkeleton />
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <ProfileAvatarDisplay
        userId={userId}
        avatarUrl={avatarUrl}
        name={userName}
        refreshTick={refreshTick}
      />

      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">上传新头像</p>
              <p className="mt-1 text-xs text-muted-foreground">
                支持 {ACCEPTED_EXT_LABEL} 格式，单张图片最大 {MAX_BYTES / 1024 / 1024}MB。
                图片会保存到 Cloudflare R2，并自动在浏览器本地缓存以加速加载。
              </p>
            </div>
            {avatarUrl ? (
              <div className="flex shrink-0 items-center gap-2 rounded-lg border border-border/60 bg-background/60 p-1.5 pr-2 text-xs text-muted-foreground">
                <Avatar className="h-6 w-6 rounded">
                  <AvatarImage src={avatarUrl} alt="当前头像" />
                  <AvatarFallback className="rounded text-[10px]">现</AvatarFallback>
                </Avatar>
                <span>将替换当前</span>
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" onClick={onPickFile} disabled={uploading || removing}>
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    {uploading ? '上传中...' : avatarUrl ? '替换头像' : '上传头像'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  推荐尺寸 200×200px，PNG / JPG / WEBP / GIF，最大 5MB
                </TooltipContent>
              </Tooltip>

              {avatarUrl ? (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={onRefresh}
                        disabled={uploading || removing}
                      >
                        <RefreshCw className="h-4 w-4" />
                        刷新
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>重新从 R2 下载头像，绕过浏览器缓存</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setConfirmRemoveOpen(true)}
                        disabled={uploading || removing}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        删除头像
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>恢复系统默认首字母头像</TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </TooltipProvider>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_MIME.join(',')}
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        <div className="rounded-lg border border-border/40 bg-card/40 px-4 text-xs text-muted-foreground">
          <Accordion type="single" collapsible>
            <AccordionItem value="cache">
              <AccordionTrigger>缓存说明</AccordionTrigger>
              <AccordionContent>
                <ul className="list-disc space-y-1 pl-4">
                  <li>首次上传后，浏览器会自动从 R2 下载一次图片并存到本地 sessionStorage。</li>
                  <li>下次刷新或重新打开页面时优先使用本地缓存，避免重复网络请求。</li>
                  <li>关闭浏览器标签后本地缓存会被清空，再次访问会重新下载。</li>
                  <li>上传新头像后会自动失效旧缓存，无需手动刷新。</li>
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>

      <AlertDialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除头像？</AlertDialogTitle>
            <AlertDialogDescription>
              头像将被恢复为系统默认（首字母占位）。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                e.preventDefault()
                void doRemove()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {removing ? '删除中...' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Building2, Check, Loader2, Save, User, UserSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import type { Profile, ProfileUpdate } from '@/types/profile'

import { ProfileInfoSkeleton } from './profile-skeletons'
import { ProfileInfoStats } from './profile-info-stats'

interface ProfileInfoTabProps {
  profile: Profile | null
  loading: boolean
  error: string | null
  onUpdate: (patch: ProfileUpdate) => Promise<Profile>
}

const MAX_LENGTH = 255

export function ProfileInfoTab({ profile, loading, error, onUpdate }: ProfileInfoTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [name, setName] = React.useState('')
  const [fullName, setFullName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [savedJustNow, setSavedJustNow] = React.useState(false)
  const [initialized, setInitialized] = React.useState(false)

  // Local state is the source of truth for the form. Seed it once when the
  // profile arrives, then keep it in sync with subsequent updates.
  React.useEffect(() => {
    if (!profile || initialized) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setInitialized(true)
  }, [profile, initialized])

  // If the profile reference changes after a successful update, refresh
  // local state so the user always sees what the server has.
  React.useEffect(() => {
    if (!profile) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
  }, [profile])

  // Dirty state — used to guard against losing unsaved changes.
  const isDirty = React.useMemo(() => {
    if (!profile) return false
    if (name.trim() !== (profile.name ?? '')) return true
    if (fullName.trim() !== (profile.full_name ?? '')) return true
    return false
  }, [profile, name, fullName])

  // Page-level beforeunload warning when there are unsaved changes.
  React.useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile || submitting) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      // 这个字段是登录名（英文 handle），后端 `name` 非空是硬约束。
      notify({ type: 'error', title: '登录名不能为空' })
      return
    }

    const patch: ProfileUpdate = {}
    if (trimmedName !== profile.name) patch.name = trimmedName
    const trimmedFull = fullName.trim()
    if ((trimmedFull || null) !== (profile.full_name ?? null)) {
      patch.full_name = trimmedFull || null
    }

    if (Object.keys(patch).length === 0) {
      notify({ type: 'info', title: '没有需要保存的修改' })
      return
    }

    setSubmitting(true)
    try {
      await onUpdate(patch)
      notify({ type: 'success', title: '资料已保存' })
      setSavedJustNow(true)
      window.setTimeout(() => setSavedJustNow(false), 2000)
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '保存失败') })
    } finally {
      setSubmitting(false)
    }
  }

  const onReset = () => {
    if (!profile) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
  }

  if (loading && !profile) {
    return <ProfileInfoSkeleton />
  }

  if (error && !profile) {
    return <p className="text-sm text-muted-foreground">无法加载个人资料，请稍后重试。</p>
  }

  if (!profile) {
    return null
  }

  const counterClass = (n: number) =>
    cn(
      'tabular-nums',
      n > MAX_LENGTH - 25 && n < MAX_LENGTH && 'text-term-warn',
      n === MAX_LENGTH && 'text-destructive'
    )

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="profile-email" className="flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
          邮箱
        </Label>
        <Input id="profile-email" type="email" value={profile.email} disabled readOnly />
        <p className="text-xs text-muted-foreground">
          邮箱用于登录，不可修改。如需更换请联系管理员。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name" className="flex items-center gap-1.5">
          <User className="h-3.5 w-3.5 text-muted-foreground" />
          登录名 *
        </Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          maxLength={MAX_LENGTH}
          required
        />
        <p className="flex items-center justify-between text-xs text-muted-foreground">
          <span>登录名（英文 handle），不再是展示名；全局显示名用下面的「姓名」</span>
          <span className={counterClass(name.length)}>
            {name.length}/{MAX_LENGTH}
          </span>
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-full-name" className="flex items-center gap-1.5">
          <UserSquare className="h-3.5 w-3.5 text-muted-foreground" />
          姓名
        </Label>
        <Input
          id="profile-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={submitting}
          maxLength={MAX_LENGTH}
          placeholder="中文姓名，例如 纪亚伟"
        />
        <p className="flex items-center justify-between text-xs text-muted-foreground">
          <span>全局显示名唯一来源：日志 / 负责人 / 创建人 / 顶部菜单都取它；留空则显示「未命名」</span>
          <span className={counterClass(fullName.length)}>
            {fullName.length}/{MAX_LENGTH}
          </span>
        </p>
      </div>

      <ProfileInfoStats profile={profile} />

      {session?.user?.email ? (
        <p className="text-xs text-muted-foreground md:col-span-2">
          当前登录身份：{session.user.email}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 md:col-span-2">
        {isDirty ? (
          <Button type="button" variant="ghost" onClick={onReset} disabled={submitting}>
            放弃修改
          </Button>
        ) : null}
        <Button type="submit" className="text-base sm:text-sm" disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : savedJustNow ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {submitting ? '保存中...' : savedJustNow ? '已保存' : '保存修改'}
        </Button>
      </div>
    </form>
  )
}

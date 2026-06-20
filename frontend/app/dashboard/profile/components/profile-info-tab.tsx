'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import type { Profile, ProfileUpdate } from '@/types/profile'

import { ProfileInfoSkeleton } from './profile-skeletons'
import { ProfileInfoStats } from './profile-info-stats'

interface ProfileInfoTabProps {
  profile: Profile | null
  loading: boolean
  error: string | null
  onUpdate: (patch: ProfileUpdate) => Promise<Profile>
}

export function ProfileInfoTab({ profile, loading, error, onUpdate }: ProfileInfoTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [name, setName] = React.useState('')
  const [fullName, setFullName] = React.useState('')
  const [operatorName, setOperatorName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [initialized, setInitialized] = React.useState(false)

  // Local state is the source of truth for the form. Seed it once when the
  // profile arrives, then keep it in sync with subsequent updates.
  React.useEffect(() => {
    if (!profile || initialized) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setOperatorName(profile.operator_name_zh ?? '')
    setInitialized(true)
  }, [profile, initialized])

  // If the profile reference changes after a successful update, refresh
  // local state so the user always sees what the server has.
  React.useEffect(() => {
    if (!profile) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setOperatorName(profile.operator_name_zh ?? '')
  }, [profile])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      notify({ type: 'error', title: '姓名不能为空' })
      return
    }

    const patch: ProfileUpdate = {}
    if (trimmedName !== profile.name) patch.name = trimmedName
    const trimmedFull = fullName.trim()
    if ((trimmedFull || null) !== (profile.full_name ?? null)) {
      patch.full_name = trimmedFull || null
    }
    const trimmedOperator = operatorName.trim()
    if ((trimmedOperator || null) !== (profile.operator_name_zh ?? null)) {
      patch.operator_name_zh = trimmedOperator || null
    }

    if (Object.keys(patch).length === 0) {
      notify({ type: 'info', title: '没有需要保存的修改' })
      return
    }

    setSubmitting(true)
    try {
      await onUpdate(patch)
      notify({ type: 'success', title: '资料已保存' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '保存失败') })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading && !profile) {
    return <ProfileInfoSkeleton />
  }

  if (error && !profile) {
    return (
      <p className="text-sm text-muted-foreground">无法加载个人资料，请稍后重试。</p>
    )
  }

  if (!profile) {
    return null
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="profile-email">邮箱</Label>
        <Input
          id="profile-email"
          type="email"
          value={profile.email}
          disabled
          readOnly
        />
        <p className="text-xs text-muted-foreground">邮箱用于登录，不可修改。如需更换请联系管理员。</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name">显示名 *</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-full-name">全名</Label>
        <Input
          id="profile-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          placeholder="可选"
        />
      </div>

      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="profile-operator-name">运营名（中文）</Label>
        <Input
          id="profile-operator-name"
          value={operatorName}
          onChange={(e) => setOperatorName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          placeholder="用于匹配项目运营 / 助理运营"
        />
        <p className="text-xs text-muted-foreground">
          ⚠ 此字段用于与项目里的运营 / 助理运营名进行匹配。修改后会自动同步到项目管理。
        </p>
      </div>

      <ProfileInfoStats profile={profile} />

      {session?.user?.email ? (
        <p className="text-xs text-muted-foreground md:col-span-2">
          当前登录身份：{session.user.email}
        </p>
      ) : null}

      <div className="flex justify-end md:col-span-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {submitting ? '保存中...' : '保存修改'}
        </Button>
      </div>
    </form>
  )
}
'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Save } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'

interface ProfileResponse {
  id: string
  email: string
  name: string
  full_name: string | null
  operator_name_zh: string | null
  is_admin: boolean
  is_active: boolean
  role_type: string
  avatar_url: string | null
  password_changed_at: string | null
}

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  operator: '运营',
  businessdev: '招商',
  factory: '工厂',
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}

export function ProfileInfoTab() {
  const { data: session, update } = useSession()
  const { notify } = useNotifications()

  const [profile, setProfile] = React.useState<ProfileResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [name, setName] = React.useState('')
  const [fullName, setFullName] = React.useState('')
  const [operatorName, setOperatorName] = React.useState('')

  // Initial fetch
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/user/profile', { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as Partial<ProfileResponse> & { message?: string }
        if (!res.ok) throw new Error(body.message || '加载失败')
        if (cancelled) return
        setProfile(body as ProfileResponse)
        setName(body.name ?? '')
        setFullName(body.full_name ?? '')
        setOperatorName(body.operator_name_zh ?? '')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        notify({ type: 'error', title: normalizeErrorMessage(err, '加载资料失败') })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [notify])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      notify({ type: 'error', title: '姓名不能为空' })
      return
    }

    setSubmitting(true)
    try {
      const payload: Record<string, string | null> = {}
      if (trimmedName !== profile.name) payload.name = trimmedName
      const trimmedFull = fullName.trim()
      if ((trimmedFull || null) !== (profile.full_name ?? null)) {
        payload.full_name = trimmedFull || null
      }
      const trimmedOperator = operatorName.trim()
      if ((trimmedOperator || null) !== (profile.operator_name_zh ?? null)) {
        payload.operator_name_zh = trimmedOperator || null
      }

      if (Object.keys(payload).length === 0) {
        notify({ type: 'info', title: '没有需要保存的修改' })
        return
      }

      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as Partial<ProfileResponse> & { message?: string }
      if (!res.ok) {
        throw new Error(body.message || '保存失败')
      }
      setProfile(body as ProfileResponse)
      setName(body.name ?? '')
      setFullName(body.full_name ?? '')
      setOperatorName(body.operator_name_zh ?? '')

      // Keep the JWT-derived session in sync so the sidebar reflects the new name.
      await update({ user: { name: body.name ?? trimmedName } })

      notify({ type: 'success', title: '资料已保存' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '保存失败') })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载...
      </div>
    )
  }

  if (!profile) {
    return (
      <p className="text-sm text-muted-foreground">无法加载个人资料，请稍后重试。</p>
    )
  }

  const roleLabel = ROLE_LABELS[profile.role_type] ?? profile.role_type

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

      <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">角色</p>
          <div className="mt-1.5">
            <Badge variant="outline">{roleLabel}</Badge>
          </div>
        </div>
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">账号状态</p>
          <div className="mt-1.5">
            <Badge variant={profile.is_active ? 'default' : 'destructive'}>
              {profile.is_active ? '启用' : '停用'}
            </Badge>
          </div>
        </div>
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">上次修改密码</p>
          <p className="mt-1.5 text-sm">{formatDate(profile.password_changed_at)}</p>
        </div>
      </div>

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
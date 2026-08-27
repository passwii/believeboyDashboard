'use client'

import { FormEvent, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermPill } from '@/components/terminal/term-controls'
import { useNotifications } from '@/components/notifications'

export default function ChangePasswordPage() {
  const { notify } = useNotifications()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!currentPassword || !newPassword || !confirmPassword) {
      notify({ type: 'error', title: '请完整填写密码信息' })
      return
    }
    if (newPassword.length < 8) {
      notify({ type: 'error', title: '新密码长度至少 8 位' })
      return
    }
    if (newPassword !== confirmPassword) {
      notify({ type: 'error', title: '两次输入的新密码不一致' })
      return
    }
    if (currentPassword === newPassword) {
      notify({ type: 'error', title: '新密码不能与当前密码一致' })
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch('/api/user/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = (await response.json()) as { message?: string }
      if (!response.ok) {
        throw new Error(data.message || '修改失败')
      }

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      notify({ type: 'success', title: '密码修改成功，请使用新密码重新登录。' })
    } catch (err) {
      notify({ type: 'error', title: err instanceof Error ? err.message : '修改失败' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-[780px]">
      <TermPanel
        title="修改密码"
        bodyClassName="p-5"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <TermPill tone="info">账号安全</TermPill>
          <span className="flex items-center gap-1.5 font-mono text-xs text-term-muted">
            <KeyRound className="h-3.5 w-3.5" />
            请输入当前密码，并设置一个新的登录密码。
          </span>
        </div>
          <form className="space-y-5" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="current-password">当前密码</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground dark:text-muted-foreground/80">
                建议至少 8 位，包含字母、数字与符号。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">确认新密码</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
              />
            </div>

            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {submitting ? '提交中...' : '确认修改'}
            </Button>
          </form>
      </TermPanel>
    </div>
  )
}

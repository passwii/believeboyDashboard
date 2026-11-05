'use client'

import { FormEvent, useState } from 'react'
import { KeyRound } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'

import styles from './change-password-warm.module.css'

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
      if (!response.ok) throw new Error(data.message || '修改失败')

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
    <div className={styles.page} data-warm-page="change-password">
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>修改密码</h1>
      </header>

      <section className={styles.panel} aria-label="修改密码">
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor="current-password" className={styles.label}>
              当前密码
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={submitting}
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="new-password" className={styles.label}>
              新密码
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={submitting}
              className={styles.input}
            />
            <p className={styles.hint}>建议至少 8 位，包含字母、数字与符号。</p>
          </div>

          <div className={styles.field}>
            <label htmlFor="confirm-password" className={styles.label}>
              确认新密码
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              className={styles.input}
            />
          </div>

          <div className={styles.actions}>
            <WarmButton
              type="submit"
              variant="primary"
              disabled={submitting}
              loading={submitting}
              loadingLabel="正在修改密码"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {submitting ? '提交中...' : '确认修改'}
            </WarmButton>
          </div>
        </form>
      </section>
    </div>
  )
}

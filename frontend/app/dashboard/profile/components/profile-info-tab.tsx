'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Building2, Check, Save, User, UserSquare } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import type { Profile, ProfileUpdate } from '@/types/profile'

import { ProfileInfoSkeleton } from './profile-skeletons'
import { ProfileInfoStats } from './profile-info-stats'
import styles from '../profile-warm.module.css'

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

  React.useEffect(() => {
    if (!profile || initialized) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setInitialized(true)
  }, [profile, initialized])

  React.useEffect(() => {
    if (!profile) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
  }, [profile])

  const isDirty = React.useMemo(() => {
    if (!profile) return false
    if (name.trim() !== (profile.name ?? '')) return true
    if (fullName.trim() !== (profile.full_name ?? '')) return true
    return false
  }, [profile, name, fullName])

  React.useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile || submitting) return

    const trimmedName = name.trim()
    if (!trimmedName) {
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

  if (loading && !profile) return <ProfileInfoSkeleton />

  if (error && !profile) {
    return (
      <p className={styles.error} role="alert">
        无法加载个人资料，请稍后重试。
      </p>
    )
  }

  if (!profile) return null

  const counterClass = (value: number) =>
    [
      styles.counter,
      value > MAX_LENGTH - 25 && value < MAX_LENGTH ? styles.counterWarning : '',
      value === MAX_LENGTH ? styles.counterInvalid : '',
    ]
      .filter(Boolean)
      .join(' ')

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      <div className={`${styles.field} ${styles.fieldFull}`}>
        <label htmlFor="profile-email" className={styles.label}>
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
          邮箱
        </label>
        <input
          id="profile-email"
          type="email"
          value={profile.email}
          className={styles.input}
          disabled
          readOnly
        />
        <p className={styles.hint}>邮箱用于登录，不可修改。如需更换请联系管理员。</p>
      </div>

      <div className={styles.field}>
        <label htmlFor="profile-name" className={styles.label}>
          <User className="h-3.5 w-3.5" aria-hidden="true" />
          登录名 *
        </label>
        <input
          id="profile-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={styles.input}
          disabled={submitting}
          maxLength={MAX_LENGTH}
          required
        />
        <p className={styles.hint}>
          登录名（英文 handle），不再是展示名；全局显示名用下面的「姓名」
          <span className={counterClass(name.length)}>
            {name.length}/{MAX_LENGTH}
          </span>
        </p>
      </div>

      <div className={styles.field}>
        <label htmlFor="profile-full-name" className={styles.label}>
          <UserSquare className="h-3.5 w-3.5" aria-hidden="true" />
          姓名
        </label>
        <input
          id="profile-full-name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          className={styles.input}
          disabled={submitting}
          maxLength={MAX_LENGTH}
          placeholder="中文姓名，例如 纪亚伟"
        />
        <p className={styles.hint}>
          全局显示名唯一来源：日志 / 负责人 / 创建人 / 顶部菜单都取它；留空则显示「未命名」
          <span className={counterClass(fullName.length)}>
            {fullName.length}/{MAX_LENGTH}
          </span>
        </p>
      </div>

      <ProfileInfoStats profile={profile} />

      {session?.user?.email ? (
        <p className={`${styles.identity} ${styles.fieldFull}`}>
          当前登录身份：{session.user.email}
        </p>
      ) : null}

      <div className={styles.actions}>
        {isDirty ? (
          <WarmButton variant="quiet" onClick={onReset} disabled={submitting}>
            放弃修改
          </WarmButton>
        ) : null}
        <WarmButton
          type="submit"
          variant="primary"
          disabled={submitting}
          loading={submitting}
          loadingLabel="正在保存资料"
        >
          {savedJustNow ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Save className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? '保存中...' : savedJustNow ? '已保存' : '保存修改'}
        </WarmButton>
      </div>
    </form>
  )
}

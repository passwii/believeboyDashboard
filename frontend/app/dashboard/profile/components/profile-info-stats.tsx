'use client'

import type { ReactNode } from 'react'
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'

import { formatDate, getRoleLabel } from './profile-shared'
import type { Profile, ProfileRoleType } from '@/types/profile'
import styles from '../profile-warm.module.css'

const ROLE_DESCRIPTIONS: Record<ProfileRoleType, string> = {
  admin: '系统全局权限',
  operator: '业务运营权限',
  businessdev: '招商业务权限',
}

interface StatCardProps {
  icon: ReactNode
  label: string
  value: ReactNode
  description: string
}

function StatCard({ icon, label, value, description }: StatCardProps) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>
        {icon}
        <span>{label}</span>
      </div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statHint}>{description}</div>
    </div>
  )
}

export function ProfileInfoStats({ profile }: { profile: Profile }) {
  return (
    <div className={styles.statsGrid}>
      <StatCard
        icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
        label="角色"
        value={getRoleLabel(profile.role_type)}
        description={ROLE_DESCRIPTIONS[profile.role_type]}
      />

      <StatCard
        icon={
          profile.is_active ? (
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ShieldOff className="h-4 w-4" aria-hidden="true" />
          )
        }
        label="账号状态"
        value={
          <WarmBadge tone={profile.is_active ? 'positive' : 'negative'}>
            {profile.is_active ? '启用' : '停用'}
          </WarmBadge>
        }
        description={profile.is_active ? '可正常登录并使用系统功能' : '已被停用，无法登录'}
      />

      <StatCard
        icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
        label="上次修改密码"
        value={
          profile.password_changed_at ? (
            <span
              className={styles.statValueInteractive}
              title={`完整时间：${profile.password_changed_at}`}
            >
              {formatDate(profile.password_changed_at)}
            </span>
          ) : (
            <span className={styles.statMuted}>—</span>
          )
        }
        description={profile.password_changed_at ? '悬停查看完整时间戳' : '尚未修改过密码'}
      />
    </div>
  )
}

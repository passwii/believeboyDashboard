'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { Crown, ExternalLink, ShieldCheck, UserCog } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

import { ProfileProjectsSkeleton } from './profile-skeletons'
import {
  type ProjectItem,
  deriveRole,
  formatCommission,
  getTierTone,
} from './profile-projects-tab-shared'
import styles from '../profile-warm.module.css'

interface ProfileProjectsTabProps {
  /** 项目匹配键是 user_accounts.full_name，与后端 X-Operator 口径一致。 */
  operatorNameCandidates: { fullName: string | null }
}

export function projectOwnerNames(fullName: string | null | undefined): string[] {
  const trimmed = fullName?.trim()
  return trimmed ? [trimmed] : []
}

function RoleIcon({ role }: { role: string }) {
  if (role === '主运营') return <Crown className={styles.badgeIcon} aria-hidden="true" />
  if (role === '助理运营') return <UserCog className={styles.badgeIcon} aria-hidden="true" />
  if (role === '管理员') return <ShieldCheck className={styles.badgeIcon} aria-hidden="true" />
  return null
}

export function ProfileProjectsTab({ operatorNameCandidates }: ProfileProjectsTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [items, setItems] = React.useState<ProjectItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const operatorNames = React.useMemo(
    () => projectOwnerNames(operatorNameCandidates.fullName),
    [operatorNameCandidates.fullName]
  )

  React.useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    fetchManagedProjectsCached<ProjectItem[]>(session, true)
      .then((data) => {
        if (!cancelled) setItems(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = normalizeErrorMessage(err, '项目列表加载失败')
        setError(message)
        notify({ type: 'error', title: message })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  if (error && !items) {
    return (
      <div className={styles.errorPanel} role="alert">
        {error}
      </div>
    )
  }

  if (items === null) return <ProfileProjectsSkeleton />

  const isAdmin = session?.user?.roleType === 'admin'
  const visibleItems = isAdmin
    ? items
    : items.filter((item) => deriveRole(item, operatorNames) !== null)

  if (visibleItems.length === 0) {
    return (
      <div className={styles.emptyState}>
        暂无可管理的项目。如果你认为自己应该出现在这里，请联系管理员核对运营 / 助理运营名是否一致。
      </div>
    )
  }

  return (
    <div className={styles.projectsArea}>
      <div className={styles.projectsPanel}>
        <div className={styles.projectsHeader}>
          <span className={styles.projectsTitle}>项目列表</span>
          <span className={styles.projectsCount}>共 {visibleItems.length} 个项目</span>
        </div>
        <div className={styles.tableScroll} data-warm-table-scroll>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>项目名</th>
                <th>品牌</th>
                <th>店铺地址</th>
                <th>等级</th>
                <th>状态</th>
                <th>我的角色</th>
                <th>佣金比例</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => {
                const role = isAdmin ? '管理员' : deriveRole(item, operatorNames)
                return (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.brand_name || '—'}</td>
                    <td>{item.store_address || '—'}</td>
                    <td>
                      {item.project_tier ? (
                        <WarmBadge tone={getTierTone(item.project_tier)}>
                          {item.project_tier}
                        </WarmBadge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <WarmBadge tone={item.is_active ? 'positive' : 'neutral'}>
                        {item.is_active ? '启用' : '停用'}
                      </WarmBadge>
                    </td>
                    <td>
                      {role ? (
                        <WarmBadge tone="accent">
                          <RoleIcon role={role} />
                          {role}
                        </WarmBadge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatCommission(item.commission_basis, item.commission_rate)}</td>
                    <td>
                      <Link
                        href={`/dashboard/system/project-info?projectId=${item.id}`}
                        className={styles.tableLink}
                      >
                        查看
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!isAdmin && operatorNames.length === 0 ? (
        <p className={styles.warning}>
          当前账号未设置姓名（full_name），无法匹配项目运营，列表为空。
        </p>
      ) : null}
    </div>
  )
}

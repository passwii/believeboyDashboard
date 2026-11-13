'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { listAgentApiKeys, type AgentApiKeyItem } from '@/lib/api/agent-key-admin'
import { formatBusinessScope } from '@/lib/agent-domains'
import {
  useAgentEmployeeSummary,
  type EmployeeSummaryMap,
} from '@/lib/hooks/use-agent-employee-summary'
import { formatRelativeTime, freshnessFor, type Freshness } from '@/lib/hooks/use-agent-domain-summary'
import styles from './employees-warm.module.css'

/**
 * Agent 中心 · 员工段(P3)。
 *
 * 凭据即身份:花名册 = ``agent_api_keys``(``listAgentApiKeys``,只读,不含已删除);
 * 活动列 = ``employee-summary`` 按 ``api_key_id`` 聚合(P3b,调用与错误统计使用最近 30 天窗口)。
 * 只读展示,凭据 CRUD 留在「Agent 接入管理」。
 */

type EmployeeStatus = 'active' | 'inactive' | 'expired'

function employeeStatus(item: AgentApiKeyItem): EmployeeStatus {
  if (item.expires_at && new Date(item.expires_at).getTime() <= Date.now()) return 'expired'
  if (item.is_revoked) return 'inactive'
  return 'active'
}

const STATUS_META: Record<EmployeeStatus, { label: string; className: string }> = {
  active: { label: '激活', className: styles.statusActive },
  inactive: { label: '停用', className: '' },
  expired: { label: '已过期', className: styles.statusExpired },
}

/** 纯函数:project_scope → 可读文案('*' = 全部项目;否则白名单计数) */
export function projectScopeText(scope: string | null | undefined): string {
  const normalized = (scope ?? '').trim()
  if (!normalized || normalized === '*') return '全部项目'
  return `${normalized.split(',').filter(Boolean).length} 个项目`
}

const FRESHNESS_STYLE: Record<Freshness, string> = {
  green: styles.freshnessPositive,
  yellow: styles.freshnessAccent,
  gray: styles.freshnessMuted,
}

const STATUS_RANK: Record<EmployeeStatus, number> = { active: 0, inactive: 1, expired: 2 }

export default function AgentEmployeesClient() {
  const [keys, setKeys] = useState<AgentApiKeyItem[] | null>(null)
  const [keysStatus, setKeysStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const summary = useAgentEmployeeSummary()

  const load = useCallback(async () => {
    setKeysStatus('loading')
    try {
      const data = await listAgentApiKeys()
      setKeys(data)
      setKeysStatus('ok')
    } catch {
      setKeys(null)
      setKeysStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const reloadAll = useCallback(() => {
    void load()
    summary.reload()
  }, [load, summary])

  useHeaderRefresh(reloadAll, {
    loading: keysStatus === 'loading' || summary.status === 'loading',
  })

  const rows = useMemo(() => {
    if (!keys) return []
    return [...keys].sort((a, b) => {
      const statusDiff = STATUS_RANK[employeeStatus(a)] - STATUS_RANK[employeeStatus(b)]
      if (statusDiff !== 0) return statusDiff
      const atA = summary.data?.[String(a.id)]?.last_active_at ?? a.last_used_at
      const atB = summary.data?.[String(b.id)]?.last_active_at ?? b.last_used_at
      const tA = atA ? new Date(atA).getTime() : 0
      const tB = atB ? new Date(atB).getTime() : 0
      return tB - tA
    })
  }, [keys, summary.data])

  return (
    <div className={styles.page} data-warm-agent-employees="true">
      <section className={styles.panel} aria-labelledby="agent-employees-title">
        <header className={styles.panelHeader}>
          <h2 id="agent-employees-title" className={styles.panelTitle}>
            员工花名册
          </h2>
          <p className={styles.panelDescription}>
            {summary.status === 'ok'
              ? '调用量与错误数由 agent 访问审计按凭据聚合(最近 30 天)'
              : '活动统计暂不可用；接入后展示最近 30 天'}
          </p>
        </header>
        {keysStatus === 'loading' ? (
          <div className={styles.loadingState} role="status" aria-busy="true">
            <span className={styles.visuallyHidden}>正在加载员工花名册</span>
            <span className={styles.skeletonBar} aria-hidden="true" />
            <span className={styles.skeletonBar} aria-hidden="true" />
            <span className={styles.skeletonBar} aria-hidden="true" />
          </div>
        ) : keysStatus === 'error' ? (
          <p className={`${styles.stateMessage} ${styles.errorMessage}`} role="alert">
            凭据花名册加载失败,可点页头刷新重试。
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.stateMessage} role="status">
            暂无 Agent 员工 —— 在{' '}
            <Link href="/dashboard/system/agent-management" className={styles.emptyLink}>
              Agent 接入管理
            </Link>{' '}
            创建凭据后自动出现。
          </p>
        ) : (
          <>
            <div
              className={styles.tableScroll}
              data-agent-employees-table-scroll
              role="region"
              aria-labelledby="agent-employees-title"
              tabIndex={0}
            >
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.colEmployee} />
                  <col className={styles.colAgentId} />
                  <col className={styles.colCapability} />
                  <col className={styles.colProject} />
                  <col className={styles.colStatus} />
                  <col className={styles.colCalls} />
                  <col className={styles.colErrors} />
                  <col className={styles.colActivity} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">员工</th>
                    <th scope="col">Agent ID</th>
                    <th scope="col">能力域</th>
                    <th scope="col">项目范围</th>
                    <th scope="col">状态</th>
                    <th scope="col">24h/30d 调用</th>
                    <th scope="col">30d 错误</th>
                    <th scope="col">最近活动</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const status = employeeStatus(item)
                    const statusMeta = STATUS_META[status]
                    const row = summary.data?.[String(item.id)]
                    const lastActive = row?.last_active_at ?? item.last_used_at
                    return (
                      <tr key={item.id}>
                        <td>
                          <span className={styles.employeeName}>{item.label}</span>
                        </td>
                        <td>
                          {item.agent_id ? (
                            <code className={styles.monoText}>{item.agent_id}</code>
                          ) : (
                            <span className={styles.secondaryText}>—（未绑定）</span>
                          )}
                        </td>
                        <td className={styles.secondaryText}>
                          {formatBusinessScope(item.business_scope)}
                        </td>
                        <td className={styles.secondaryText}>
                          {projectScopeText(item.project_scope)}
                        </td>
                        <td>
                          <span className={`${styles.statusBadge} ${statusMeta.className}`}>
                            {statusMeta.label}
                          </span>
                        </td>
                        <td>
                          {row ? (
                            <span
                              className={`${styles.numeric} ${styles.mutedValue}`}
                              title={`写 24h:${row.writes_24h} · 写 30d:${row.writes_30d}`}
                            >
                              {row.calls_24h} / {row.calls_30d}
                            </span>
                          ) : summary.data ? (
                            <span className={styles.placeholder}>30 天内无调用</span>
                          ) : (
                            <span className={styles.placeholder}>—</span>
                          )}
                        </td>
                        <td>
                          {row ? (
                            <span
                              className={`${styles.numeric} ${row.errors_30d > 0 ? styles.negativeValue : styles.mutedValue}`}
                              data-tone={row.errors_30d > 0 ? 'negative' : 'muted'}
                            >
                              {row.errors_30d}
                            </span>
                          ) : summary.data ? (
                            <span className={`${styles.numeric} ${styles.mutedValue}`}>0</span>
                          ) : (
                            <span className={styles.placeholder}>—</span>
                          )}
                        </td>
                        <td>
                          <span className={styles.freshness}>
                            <span
                              aria-hidden
                              className={`${styles.freshnessDot} ${FRESHNESS_STYLE[freshnessFor(lastActive)]}`}
                            />
                            <span>{formatRelativeTime(lastActive)}</span>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div
              className={styles.mobileList}
              data-mobile-employee-list="true"
              role="list"
              aria-label="Agent 员工"
            >
              {rows.map((item) => {
                const status = employeeStatus(item)
                const statusMeta = STATUS_META[status]
                const row = summary.data?.[String(item.id)]
                const lastActive = row?.last_active_at ?? item.last_used_at
                return (
                  <article className={styles.mobileCard} key={`mobile-${item.id}`} role="listitem">
                    <header className={styles.mobileCardHeader}>
                      <h3 className={styles.mobileEmployeeName}>{item.label}</h3>
                      <span className={`${styles.statusBadge} ${statusMeta.className}`}>
                        {statusMeta.label}
                      </span>
                    </header>
                    <dl className={styles.mobileActivityGrid}>
                      <div>
                        <dt>24h/30d 调用</dt>
                        <dd
                          className={styles.numeric}
                          title={
                            row
                              ? `写 24h:${row.writes_24h} · 写 30d:${row.writes_30d}`
                              : undefined
                          }
                        >
                          {row
                            ? `${row.calls_24h} / ${row.calls_30d}`
                            : summary.data
                              ? '30 天内无调用'
                              : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt>24h/30d 写入</dt>
                        <dd className={styles.numeric}>
                          {row
                            ? `${row.writes_24h} / ${row.writes_30d}`
                            : summary.data
                              ? '30 天内无调用'
                              : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt>30d 错误</dt>
                        <dd
                          className={
                            row?.errors_30d
                              ? `${styles.numeric} ${styles.negativeValue}`
                              : styles.numeric
                          }
                          data-tone={row?.errors_30d ? 'negative' : 'muted'}
                        >
                          {row ? row.errors_30d : summary.data ? 0 : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt>最近活动</dt>
                        <dd className={styles.freshness}>
                          <span
                            aria-hidden
                            className={`${styles.freshnessDot} ${FRESHNESS_STYLE[freshnessFor(lastActive)]}`}
                          />
                          <span>{formatRelativeTime(lastActive)}</span>
                        </dd>
                      </div>
                    </dl>
                    <details className={styles.mobileDetails}>
                      <summary>员工详情</summary>
                      <dl className={styles.mobileDetailsGrid}>
                        <div>
                          <dt>Agent ID</dt>
                          <dd>
                            {item.agent_id ? (
                              <code className={styles.monoText}>{item.agent_id}</code>
                            ) : (
                              '—（未绑定）'
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>能力域</dt>
                          <dd>{formatBusinessScope(item.business_scope)}</dd>
                        </div>
                        <div>
                          <dt>项目范围</dt>
                          <dd>{projectScopeText(item.project_scope)}</dd>
                        </div>
                      </dl>
                    </details>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

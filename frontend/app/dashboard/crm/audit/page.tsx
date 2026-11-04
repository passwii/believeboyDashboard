'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsersSafe } from '@/hooks/use-crm-users'
import { resolveAuditSummary } from '@/lib/crm/method/audit-summary'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditAction, AuditLog } from '@/lib/crm/types'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmPage,
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableScroller,
  WarmCrmToolbar,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './audit-warm.module.css'

/** 实体类型 → 中文标签（筛选用）。 */
const ENTITY_LABELS: Record<string, string> = {
  customer: '客户',
  lead: '线索',
  contact: '联系人',
  task: '任务',
}

const ENTITY_OPTIONS = [
  { value: 'all', label: '全部对象' },
  ...Object.entries(ENTITY_LABELS).map(([value, label]) => ({ value, label })),
]

const ACTION_OPTIONS = [
  { value: 'all', label: '全部操作' },
  ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
]

const ACTION_TONES: Record<string, WarmCrmStatusTone> = {
  create: 'positive',
  complete: 'positive',
  convert: 'positive',
  claim: 'positive',
  delete: 'negative',
  move_sea: 'negative',
  update: 'accent',
  status: 'accent',
}

/** 筛选「全部」的哨兵值。 */
const ALL = 'all'
const PAGE_SIZE = 30

/**
 * CRM 操作日志页（P4 审计日志，仅管理员）。
 *
 * 权限仍由后端 require_admin 兜底；当前将所有拉取错误映射为「无权限」的页面语义
 * 保持不变，不在视觉迁移中调整安全行为。
 */
export default function CrmAuditPage() {
  const client = useCrmClient()
  const users = useCrmUsersSafe()
  const [entityType, setEntityType] = useState<string>(ALL)
  const [action, setAction] = useState<string>(ALL)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setForbidden(false)
    try {
      const response = await client.listAuditLogs({
        entityType: entityType === ALL ? undefined : entityType,
        action: action === ALL ? undefined : action,
        page,
        pageSize: PAGE_SIZE,
      })
      setItems(response.items)
      setTotal(response.total)
    } catch {
      setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [client, entityType, action, page])

  useEffect(() => {
    void load()
  }, [load])

  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (forbidden) {
    return (
      <WarmCrmPage>
        <WarmCrmState
          kind="empty"
          title="无权限查看操作日志（仅管理员）"
          action={<ShieldAlert aria-hidden="true" />}
        />
      </WarmCrmPage>
    )
  }

  return (
    <WarmCrmPage>
      <WarmCrmToolbar
        ariaLabel="操作日志筛选"
        start={
          <>
            <WarmSelect
              id="audit-entity-filter"
              label="对象"
              value={entityType}
              options={ENTITY_OPTIONS}
              onChange={(value) => {
                setEntityType(value)
                setPage(1)
              }}
            />
            <WarmSelect
              id="audit-action-filter"
              label="操作"
              value={action}
              options={ACTION_OPTIONS}
              onChange={(value) => {
                setAction(value)
                setPage(1)
              }}
            />
          </>
        }
        end={!loading ? <span className={styles.recordCount}>共 {total} 条记录</span> : null}
      />

      <WarmCrmSection aria-label="操作日志">
        {loading ? (
          <WarmCrmState kind="loading" title="加载中" />
        ) : items.length === 0 ? (
          <WarmCrmState kind="empty" title="暂无操作记录" />
        ) : (
          <WarmCrmTableScroller ariaLabel="操作日志表格">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>对象</th>
                  <th>操作</th>
                  <th>操作人</th>
                  <th>变更</th>
                </tr>
              </thead>
              <tbody>
                {items.map((log) => (
                  <tr key={log.id}>
                    <td
                      className={styles.timestamp}
                      title={new Date(log.createdAt).toLocaleString('zh-CN')}
                    >
                      {new Date(log.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className={styles.entity}>
                      {ENTITY_LABELS[log.entityType] ?? log.entityType}
                      <span>#{log.entityId}</span>
                    </td>
                    <td>
                      <WarmCrmStatusPill
                        tone={ACTION_TONES[log.action] ?? 'neutral'}
                        title={AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}
                      >
                        {AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}
                      </WarmCrmStatusPill>
                    </td>
                    <td>{log.actorName ?? '系统'}</td>
                    <td
                      className={styles.summary}
                      title={log.summary ? resolveAuditSummary(log.summary, users) : '-'}
                    >
                      {log.summary ? resolveAuditSummary(log.summary, users) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </WarmCrmTableScroller>
        )}
      </WarmCrmSection>

      <div className={styles.pagination}>
        <WarmButton
          disabled={page <= 1 || loading}
          onClick={() => setPage((current) => current - 1)}
        >
          <ChevronLeft aria-hidden="true" />
          上一页
        </WarmButton>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <WarmButton
          disabled={page >= totalPages || loading}
          onClick={() => setPage((current) => current + 1)}
        >
          下一页
          <ChevronRight aria-hidden="true" />
        </WarmButton>
      </div>
    </WarmCrmPage>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsersSafe } from '@/hooks/use-crm-users'
import { resolveAuditSummary } from '@/lib/crm/method/audit-summary'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditAction, AuditLog } from '@/lib/crm/types'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  TERM_SELECT_NATIVE,
  TermEnumPill,
  AUDIT_ACTION_TERM,
} from '@/components/crm/term-shared'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** 实体类型 → 中文标签（筛选用）。 */
const ENTITY_LABELS: Record<string, string> = {
  customer: '客户',
  lead: '线索',
  contact: '联系人',
  task: '任务',
}

/** 筛选「全部」的 Radix Select 哨兵值（Radix 不允许空字符串 value）。 */
const ALL = 'all'
const PAGE_SIZE = 30

/**
 * CRM 操作日志页（P4 审计日志，仅管理员）。
 *
 * 可见性：sidebar 不做角色墙（roles 已移除），权限由后端 require_admin 兜底——
 * 非管理员调用 listAuditLogs 返回 403，本页优雅展示「无权限」而非报错。
 * 数据拉取沿用本仓库 useEffect + useState 范式（项目未引入 react-query）。
 */
export default function CrmAuditPage() {
  const client = useCrmClient()
  // BLF-1440：与详情抽屉一致，摘要里的 owner uuid 按用户目录还原姓名。
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
      const res = await client.listAuditLogs({
        entityType: entityType === ALL ? undefined : entityType,
        action: action === ALL ? undefined : action,
        page,
        pageSize: PAGE_SIZE,
      })
      setItems(res.items)
      setTotal(res.total)
    } catch {
      // 后端 require_admin 对非管理员返回 403 → 展示「无权限」
      setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [client, entityType, action, page])

  useEffect(() => {
    void load()
  }, [load])

  // —— BLF-837：全局刷新接入 Top Header（原页内刷新按钮移除，语义一致）——
  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (forbidden) {
    return (
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-col items-center gap-2 border border-term-warn/40 bg-term-warn/5 px-6 py-12 text-center">
          <ShieldAlert className="h-7 w-7 text-term-warn" />
          <p className="font-mono text-xs uppercase tracking-wider text-term-warn">
            无权限查看操作日志（仅管理员）
          </p>
        </div>
      </div>
    )
  }

  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载；筛选行终端控件；刷新上移 Header
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* 筛选 + 总数（规则 2/9：手机 2 列网格内联标签，md+ 横向排列） */}
      <div className="grid grid-cols-2 items-end gap-2 md:flex md:flex-wrap md:items-center md:gap-1.5">
        <label className="flex flex-col gap-1 text-xs md:flex-row md:items-center md:gap-1.5">
          <span className="font-mono uppercase tracking-wider text-term-muted">对象</span>
          <select
            aria-label="按对象筛选"
            className={`${TERM_SELECT_NATIVE} w-full tabular-nums md:w-auto`}
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value)
              setPage(1)
            }}
          >
            <option value={ALL}>全部对象</option>
            {Object.entries(ENTITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs md:flex-row md:items-center md:gap-1.5">
          <span className="font-mono uppercase tracking-wider text-term-muted">操作</span>
          <select
            aria-label="按操作筛选"
            className={`${TERM_SELECT_NATIVE} w-full tabular-nums md:w-auto`}
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setPage(1)
            }}
          >
            <option value={ALL}>全部操作</option>
            {Object.entries(AUDIT_ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {!loading && (
          <span className="col-span-2 font-mono text-xs tabular-nums text-term-faint md:ml-auto md:col-span-1">
            共 {total} 条记录
          </span>
        )}
      </div>

      {/* 日志表格（终端高密度） */}
      <TermPanel bodyClassName="min-h-0 overflow-auto">
        <TermTable>
          <TermTHead>
            <TermRow>
              <TermHead>时间</TermHead>
              <TermHead>对象</TermHead>
              <TermHead>操作</TermHead>
              <TermHead>操作人</TermHead>
              <TermHead>变更</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TermRow key={i}>
                  <TermCell colSpan={5} tone="muted" className="animate-pulse">
                    <span className="inline-block h-3 w-full bg-term-raised" aria-hidden />
                  </TermCell>
                </TermRow>
              ))
            ) : items.length === 0 ? (
              <TermRow>
                <TermCell colSpan={5} className="h-20 text-center" tone="muted">
                  暂无操作记录
                </TermCell>
              </TermRow>
            ) : (
              items.map((log) => (
                <TermRow key={log.id}>
                  <TermCell
                    tone="muted"
                    title={new Date(log.createdAt).toLocaleString('zh-CN')}
                    className="whitespace-nowrap"
                  >
                    {new Date(log.createdAt).toLocaleString('zh-CN')}
                  </TermCell>
                  <TermCell className="whitespace-nowrap">
                    {ENTITY_LABELS[log.entityType] ?? log.entityType}
                    <span className="ml-1 font-mono text-term-faint">#{log.entityId}</span>
                  </TermCell>
                  <TermCell>
                    <TermEnumPill
                      tone={AUDIT_ACTION_TERM[log.action as AuditAction] ?? 'muted'}
                      title={AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}
                    >
                      {AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}
                    </TermEnumPill>
                  </TermCell>
                  <TermCell className="whitespace-nowrap">{log.actorName ?? '系统'}</TermCell>
                  <TermCell
                    tone="muted"
                    className="max-w-[360px]"
                    title={log.summary ? resolveAuditSummary(log.summary, users) : '-'}
                  >
                    <span className="line-clamp-2">
                      {log.summary ? resolveAuditSummary(log.summary, users) : '-'}
                    </span>
                  </TermCell>
                </TermRow>
              ))
            )}
          </TermBody>
        </TermTable>
      </TermPanel>

      {/* 分页 */}
      <div className="flex items-center justify-end gap-1.5 font-mono text-xs text-term-muted">
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text"
          disabled={page <= 1 || loading}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <span className="px-1 tabular-nums">
          第 {page} / {totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text"
          disabled={page >= totalPages || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { ApiError } from '@/lib/crm/api/http-crm-client'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditAction, AuditLog } from '@/lib/crm/types'
import { formatRelativeTime } from '@/lib/crm/method/format'
import { cn } from '@/lib/utils'
import {
  AUDIT_ACTION_TERM,
  TermEnumPill,
} from '@/components/crm/term-shared'

/** 动作 → 时间线节点色（BLF-837 终端语义，与 AUDIT_ACTION_TERM 同源）。 */
const ACTION_TERM_DOT: Record<string, string> = {
  create: 'bg-term-pos',
  complete: 'bg-term-pos',
  convert: 'bg-term-pos',
  claim: 'bg-term-pos',
  delete: 'bg-term-neg',
  move_sea: 'bg-term-neg',
  cancel: 'bg-term-faint',
  transfer: 'bg-term-accent',
  update: 'bg-term-accent',
  status: 'bg-term-accent',
}

/** 动作 → 徽标配色（旧彩色胶囊，audit 页已改走 AUDIT_ACTION_TERM 单色 pill；此处保留供非终端场景回退）。 */
export const ACTION_BADGE: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  update: 'bg-term-accent/10 text-term-accent',
  delete: 'bg-term-neg/10 text-term-neg',
  transfer: 'bg-term-accent/10 text-term-accent',
  move_sea: 'bg-term-warn/10 text-term-warn',
  claim: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
  convert: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  complete: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  cancel: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
  status: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
}

interface CrmAuditTimelineProps {
  entityType: 'customer' | 'lead' | 'contact' | 'task'
  entityId: string
  /**
   * P5-9: 可选附加过滤。多值传入时与 entityType/entityId 合并（AND 关系）。
   * 用于客户抽屉同时展示客户审计 + 该客户下联系人的审计。
   */
  extraEntityTypes?: ('customer' | 'contact' | 'lead' | 'task')[]
  extraEntityIds?: number[]
}

/**
 * 操作记录时间线（P4 审计日志）：拉取某实体的审计记录并时间线展示。
 * 客户/线索详情抽屉「操作记录」Tab 复用；管理员页用独立的表格视图。
 * 数据拉取沿用本仓库 useEffect + useState 范式（项目未引入 react-query）。
 *
 * P5-11: 错误信息按 ApiError.status 区分（401/403/5xx/network），不再一律「无权限」。
 */
export function CrmAuditTimeline({
  entityType,
  entityId,
  extraEntityTypes,
  extraEntityIds,
}: CrmAuditTimelineProps) {
  const client = useCrmClient()
  const [items, setItems] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ kind: 'forbidden' | 'unauthorized' | 'server' | 'network' | 'unknown'; message: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // P5-9: 客户场景先取该客户的联系人 id，审计时间线同时展示客户 + 联系人审计。
      let contactIds: number[] = []
      const baseTypes: string[] = [entityType]
      if (entityType === 'customer') {
        const contacts = await client.listContacts(entityId)
        contactIds = contacts.map((c) => Number(c.id)).filter((n) => !Number.isNaN(n))
        if (contactIds.length > 0) baseTypes.push('contact')
      }
      // 合并 base + extraEntityTypes 去重
      const typesSet = new Set<string>([...baseTypes, ...(extraEntityTypes ?? [])])
      const entityTypes = Array.from(typesSet)
      // 多实体查询时把主 entityId 与联系人 id（及 extraEntityIds）并入 id 集（去重）。
      // "extra" 语义为「附加」，主 entityId 始终包含在内。
      const multiEntity = entityTypes.length > 1
      const ids = multiEntity
        ? Array.from(
            new Set<number>([
              Number(entityId),
              ...contactIds,
              ...(extraEntityIds ?? []),
            ])
          )
        : undefined
      const page = await client.listAuditLogs({
        entityType,
        entityId,
        entityTypes: multiEntity ? entityTypes : undefined,
        entityIds: ids,
        pageSize: 50,
      })
      setItems(page.items)
    } catch (e) {
      // P5-11: 按 status 分类提示
      if (e instanceof ApiError) {
        if (e.status === 401) {
          setError({ kind: 'unauthorized', message: '请重新登录' })
        } else if (e.status === 403) {
          setError({ kind: 'forbidden', message: '无权限查看此操作记录' })
        } else if (e.status >= 500) {
          setError({ kind: 'server', message: '服务器错误，请稍后重试' })
        } else {
          setError({ kind: 'unknown', message: e.message })
        }
      } else if (e instanceof TypeError) {
        // fetch 失败（断网/CORS/abort）—— TypeError
        setError({ kind: 'network', message: '网络错误，请检查连接后重试' })
      } else {
        setError({ kind: 'unknown', message: (e as Error)?.message ?? '加载失败' })
      }
    } finally {
      setLoading(false)
    }
  }, [client, entityType, entityId, extraEntityTypes, extraEntityIds])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-3 py-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (error) {
    return <EmptyState icon="file" message={error.message} />
  }

  if (items.length === 0) {
    return <EmptyState icon="file" message="暂无操作记录" />
  }

  return (
    <ScrollArea className="h-[280px] pr-3">
      {/* BLF-837：时间线终端规格——term 轨道/节点/卡片、单色动作 pill */}
      <ol className="relative space-y-2 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-term-border before:content-['']">
        {items.map((log) => (
          <li key={log.id} className="relative pl-6">
            {/* 时间线节点：覆盖在竖轨上的圆点 */}
            <span
              className={cn(
                'absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-term-bg',
                ACTION_TERM_DOT[log.action] ?? 'bg-term-faint'
              )}
              aria-hidden
            />
            <div className="border border-term-border bg-term-panel p-2.5 transition-colors hover:bg-term-hover">
              <div className="mb-1 flex items-center justify-between gap-2">
                <TermEnumPill tone={AUDIT_ACTION_TERM[log.action] ?? 'muted'}>
                  {AUDIT_ACTION_LABELS[log.action] ?? log.action}
                </TermEnumPill>
                <span className="shrink-0 font-mono text-xs tabular-nums text-term-faint">
                  {log.actorName ?? '系统'} · {formatRelativeTime(log.createdAt)}
                </span>
              </div>
              {log.summary ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-term-text">
                  {log.summary}
                </p>
              ) : (
                <p className="text-sm text-term-faint">（无变更详情）</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  )
}
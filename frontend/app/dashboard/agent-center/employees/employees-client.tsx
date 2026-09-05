'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { listAgentApiKeys, type AgentApiKeyItem } from '@/lib/api/agent-key-admin'
import { formatBusinessScope } from '@/lib/agent-domains'
import {
  useAgentEmployeeSummary,
  type EmployeeSummaryMap,
} from '@/lib/hooks/use-agent-employee-summary'
import { formatRelativeTime, freshnessFor, type Freshness } from '@/lib/hooks/use-agent-domain-summary'

/**
 * Agent 中心 · 员工段(P3)。
 *
 * 凭据即身份:花名册 = ``agent_api_keys``(``listAgentApiKeys``,只读,不含已删除);
 * 活动列 = ``employee-summary`` 按 ``api_key_id`` 聚合(P3b,端点未上线降级占位)。
 * 只读展示,凭据 CRUD 留在「Agent 接入管理」。
 */

type EmployeeStatus = 'active' | 'inactive' | 'expired'

function employeeStatus(item: AgentApiKeyItem): EmployeeStatus {
  if (item.expires_at && new Date(item.expires_at).getTime() <= Date.now()) return 'expired'
  if (item.is_revoked) return 'inactive'
  return 'active'
}

const STATUS_META: Record<EmployeeStatus, { label: string; className: string }> = {
  active: { label: '激活', className: 'border-term-pos/40 text-term-pos' },
  inactive: { label: '停用', className: 'text-term-faint' },
  expired: { label: '已过期', className: 'text-term-warn' },
}

/** 纯函数:project_scope → 可读文案('*' = 全部项目;否则白名单计数) */
export function projectScopeText(scope: string | null | undefined): string {
  const normalized = (scope ?? '').trim()
  if (!normalized || normalized === '*') return '全部项目'
  return `${normalized.split(',').filter(Boolean).length} 个项目`
}

const FRESHNESS_STYLE: Record<Freshness, string> = {
  green: 'text-term-pos',
  yellow: 'text-term-warn',
  gray: 'text-term-faint',
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

  const activeCount = (keys ?? []).filter((k) => employeeStatus(k) === 'active').length

  return (
    <div className="w-full space-y-6">
      <PageHeader
        eyebrow="Agent 中心 · 员工"
        title="Agent 员工"
        description={`凭据即身份 —— 共 ${keys?.length ?? 0} 位员工、${activeCount} 位在职。能力域、项目范围与最近活动一览;创建 / 停用凭据请前往 Agent 接入管理。`}
      />

      <DataTableCard>
        <DataTableCardHeader
          title="员工花名册"
          description={
            summary.status === 'ok'
              ? '活动列由 agent 访问审计按凭据聚合(最近 7 天)'
              : '活动列待 employee-summary 端点(P3b)部署后点亮'
          }
        />
        <DataTableCardBody>
          {keysStatus === 'loading' ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-8 w-full rounded-none" />
              <Skeleton className="h-8 w-full rounded-none" />
              <Skeleton className="h-8 w-full rounded-none" />
            </div>
          ) : keysStatus === 'error' ? (
            <div className="py-8 text-center text-sm text-term-neg">凭据花名册加载失败,可点页头刷新重试。</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-term-muted">
              暂无 Agent 员工 —— 在{' '}
              <Link
                href="/dashboard/system/agent-management"
                className="underline underline-offset-4 hover:text-term-accent"
              >
                Agent 接入管理
              </Link>{' '}
              创建凭据后自动出现。
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[180px]">员工</TableHead>
                  <TableHead className="w-[160px]">Agent ID</TableHead>
                  <TableHead>能力域</TableHead>
                  <TableHead className="w-[100px]">项目范围</TableHead>
                  <TableHead className="w-[80px]">状态</TableHead>
                  <TableHead className="w-[100px]">24h/7d 调用</TableHead>
                  <TableHead className="w-[80px]">7d 错误</TableHead>
                  <TableHead className="w-[120px]">最近活动</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => {
                  const status = employeeStatus(item)
                  const statusMeta = STATUS_META[status]
                  const row = summary.data?.[String(item.id)]
                  const lastActive = row?.last_active_at ?? item.last_used_at
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.label}</TableCell>
                      <TableCell>
                        {item.agent_id ? (
                          <code className="font-mono text-xs text-term-muted">{item.agent_id}</code>
                        ) : (
                          <span className="text-xs text-term-faint">—（未绑定）</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-term-muted">
                        {formatBusinessScope(item.business_scope)}
                      </TableCell>
                      <TableCell className="text-xs text-term-muted">
                        {projectScopeText(item.project_scope)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`rounded-none font-mono text-[11px] ${statusMeta.className}`}
                        >
                          {statusMeta.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row ? (
                          <span
                            className="font-mono text-xs tabular-nums text-term-muted"
                            title={`写 24h:${row.writes_24h} · 写 7d:${row.writes_7d}`}
                          >
                            {row.calls_24h} / {row.calls_7d}
                          </span>
                        ) : (
                          <span className="text-term-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row ? (
                          <span
                            className={`font-mono text-xs tabular-nums ${
                              row.errors_7d > 0 ? 'text-term-neg' : 'text-term-muted'
                            }`}
                          >
                            {row.errors_7d}
                          </span>
                        ) : (
                          <span className="text-term-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums text-term-muted">
                          <span
                            aria-hidden
                            className={FRESHNESS_STYLE[freshnessFor(lastActive)]}
                          >
                            ●
                          </span>
                          {formatRelativeTime(lastActive)}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}

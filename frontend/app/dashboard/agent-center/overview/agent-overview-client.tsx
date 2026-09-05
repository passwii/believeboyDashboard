'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
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
import {
  freshnessFor,
  type Freshness,
  useAgentDomainSummary,
} from '@/lib/hooks/use-agent-domain-summary'
import { useAgentProduction } from '@/lib/hooks/use-agent-production'
import { AGENT_DOMAINS } from '@/lib/agent-domains'

/**
 * Agent 中心 · 数据流总览。
 *
 * 静态部分 = AGENT_DOMAINS 注册表(接入状态 / 能力 / 入口跳转,产出域置顶呼应侧栏叙事);
 * 运行时部分 = domain-summary 聚合(P2b 前端已预埋):最近活动(新鲜度灯)/ 24h·7d 调用量 / 7d 错误率,
 * 后端端点未上线时三列降级为占位「—」,上线后自动点亮。
 */

/** 产出域置顶顺序(A 档,与侧栏分组呼应);account_health 读侧同属巡检产出。 */
const PRODUCE_DOMAIN_ORDER = [
  'complaint_center',
  'platform_inspection',
  'account_health',
  'report_upload_status',
  'report_upload',
]

const PRODUCE_RANK = new Map(PRODUCE_DOMAIN_ORDER.map((code, i) => [code, i]))

function domainSortKey(code: string, status: string): number {
  if (status !== 'live') return 3
  return PRODUCE_RANK.get(code) ?? 2
}

const sortedDomains = [...AGENT_DOMAINS].sort(
  (a, b) => domainSortKey(a.code, a.status) - domainSortKey(b.code, b.status)
)

const FRESHNESS_STYLE: Record<Freshness, string> = {
  green: 'text-term-pos',
  yellow: 'text-term-warn',
  gray: 'text-term-faint',
}

export type ProductionCell = { text: string; mono: boolean } | null

/** 纯函数:按域 code 计算今日产出单元格(null = 占位「—」,含源失败 / 无数据 / 非产出域) */
export function productionCell(code: string, production: ReturnType<typeof useAgentProduction> | null): ProductionCell {
  if (!production) return null
  switch (code) {
    case 'complaint_center':
      // 今日巡检 run 存在才展示待回复数;无 run(未巡检)与源失败同样占位
      return production.complaints.hasRun && production.complaints.needsReply !== null
        ? { text: `待回复 ${production.complaints.needsReply}`, mono: false }
        : null
    case 'platform_inspection':
    case 'account_health':
      return production.inspection.submitted !== null && production.inspection.total !== null
        ? { text: `${production.inspection.submitted}/${production.inspection.total} 报告`, mono: true }
        : null
    case 'report_upload':
    case 'report_upload_status':
      return production.reports.uploaded !== null && production.reports.total !== null
        ? { text: `${production.reports.uploaded}/${production.reports.total} 报表`, mono: true }
        : null
    default:
      return null
  }
}

/** 纯函数:ISO 时间 → 相对时长文案(刚刚 / N 分钟前 / N 小时前 / N 天前 / M/D) */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '从未'
  const minutes = (now.getTime() - t) / 60_000
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  const days = hours / 24
  if (days < 30) return `${Math.floor(days)} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function errorRateText(errors7d: number, calls7d: number): string {
  if (calls7d <= 0) return '—'
  return `${Math.round((errors7d / calls7d) * 100)}%`
}

export default function AgentOverviewClient() {
  const liveCount = AGENT_DOMAINS.filter((d) => d.status === 'live').length
  const { data: summary, status: summaryStatus, reload: reloadSummary } = useAgentDomainSummary()
  const production = useAgentProduction()

  const reloadAll = useCallback(() => {
    reloadSummary()
    production.reload()
  }, [reloadSummary, production])

  useHeaderRefresh(reloadAll, {
    loading: summaryStatus === 'loading' || production.loading,
  })

  return (
    <div className="w-full space-y-6">
      <PageHeader
        eyebrow="Agent 中心 · 数据流"
        title="数据流总览"
        description={`${AGENT_DOMAINS.length} 个业务域、${liveCount} 个已接入 —— Agent 员工在各业务域活动的归集点,点击入口前往对应工作台。`}
      />

      <div className="rounded-none border border-dashed border-term-border bg-term-panel px-4 py-3 text-xs leading-6 text-term-muted">
        「今日产出」为实时业务数据(客诉概览 / 巡检周期 / 报表完成度);运行时活动列(最近活动 /
        24h·7d 调用量 / 7d 错误率)由 domain-summary
        端点驱动(契约见 docs/superpowers/plans/2026-09-05-agent-dataflow-overview
        §P2b),端点上线前显示占位「—」。
      </div>

      <DataTableCard>
        <DataTableCardHeader
          title="业务域活动矩阵"
          description={
            summaryStatus === 'ok'
              ? '每行一个 Agent 业务域:能力、路由、运行时活动与前端入口;产出域(客诉 / 巡检 / 报表)置顶'
              : '每行一个 Agent 业务域:能力、路由与前端入口;运行时列待 domain-summary 端点(P2b)上线'
          }
        />
        <DataTableCardBody>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[170px]">业务域</TableHead>
                <TableHead>说明</TableHead>
                <TableHead className="w-[100px]">能力</TableHead>
                <TableHead className="w-[70px]">路由</TableHead>
                <TableHead className="w-[120px]">最近活动</TableHead>
                <TableHead className="w-[100px]">24h/7d 调用</TableHead>
                <TableHead className="w-[80px]">7d 错误</TableHead>
                <TableHead className="w-[110px]">今日产出</TableHead>
                <TableHead className="w-[100px]">接入状态</TableHead>
                <TableHead className="w-[120px]">Dashboard 入口</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedDomains.map((domain) => {
                const live = domain.status === 'live'
                const row = summary?.[domain.code]
                return (
                  <TableRow key={domain.code} className={live ? undefined : 'text-term-faint'}>
                    <TableCell className={live ? 'font-medium' : 'font-medium text-term-faint'}>
                      {domain.label}
                      {!live && (
                        <span className="ml-2 font-mono text-[11px] text-term-faint">
                          #{domain.code}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[300px] text-xs text-term-muted line-clamp-2">
                      {domain.description}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {domain.capabilities.read && (
                          <Badge
                            variant="outline"
                            className="rounded-none font-mono text-[11px] text-term-muted"
                          >
                            读
                          </Badge>
                        )}
                        {domain.capabilities.write && (
                          <Badge
                            variant="outline"
                            className="rounded-none font-mono text-[11px] text-term-muted"
                          >
                            写
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-term-muted">
                      {live ? domain.routeCount : '—'}
                    </TableCell>
                    <TableCell>
                      {row ? (
                        <span
                          className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums text-term-muted"
                          title={`最近活动:${formatRelativeTime(row.last_active_at)}`}
                        >
                          <span
                            aria-hidden
                            className={FRESHNESS_STYLE[freshnessFor(row.last_active_at)]}
                          >
                            ●
                          </span>
                          {formatRelativeTime(row.last_active_at)}
                        </span>
                      ) : (
                        <span className="text-term-faint">—</span>
                      )}
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
                          {errorRateText(row.errors_7d, row.calls_7d)}
                        </span>
                      ) : (
                        <span className="text-term-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const cell = productionCell(domain.code, production)
                        if (!cell) return <span className="text-term-faint">—</span>
                        return (
                          <span
                            className={`text-xs text-term-muted ${cell.mono ? 'font-mono tabular-nums' : ''}`}
                            title="今日产出(Agent 写入 / 提交 / 上传)"
                          >
                            {cell.text}
                          </span>
                        )
                      })()}
                    </TableCell>
                    <TableCell>
                      {live ? (
                        <Badge
                          variant="outline"
                          className="rounded-none border-term-pos/40 font-mono text-[11px] text-term-pos"
                        >
                          已接入
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="rounded-none font-mono text-[11px] text-term-faint"
                        >
                          规划中
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {domain.dashboardPath ? (
                        <Link
                          href={domain.dashboardPath}
                          aria-label={`打开${domain.label}`}
                          className="inline-flex items-center gap-1 font-mono text-xs text-term-text underline-offset-4 hover:text-term-accent hover:underline"
                        >
                          进入
                          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      ) : (
                        <span className="text-term-faint">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}

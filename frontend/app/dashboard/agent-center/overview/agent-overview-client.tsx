'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  ColGroup,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  numericCell,
  numericHead,
  StatusPill,
} from '@/components/ui/table-presets'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  formatRelativeTime,
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
    <div className="w-full">
      <DataTableCard>
        <DataTableCardHeader
          title="业务域活动矩阵"
          description={`共 ${AGENT_DOMAINS.length} 个业务域、${liveCount} 个已接入,产出域置顶。 「今日产出」为实时业务数据,运行时活动与 7d 错误率由 domain-summary 提供;已接入域在 7 天内无调用时显示 0 和「无调用」,接口不可用时显示「—」。`}
        />
        <DataTableCardBody>
          {/* 11 列定宽 + 「说明」吸收余量：窄屏由 Table 原语容器承接横滑（table-spec §1.7） */}
          <Table tableLayout="fixed" className="min-w-[1040px]">
            <ColGroup
              columns={[
                { width: 140 }, // 业务域
                { width: 'auto' }, // 说明（弹性列，吸收剩余宽度）
                { width: 88 }, // 能力
                { width: 56 }, // 路由
                { width: 96 }, // 最近活动
                { width: 80 }, // 调用 24h
                { width: 80 }, // 调用 7d
                { width: 80 }, // 7d 错误
                { width: 100 }, // 今日产出
                { width: 80 }, // 状态
                { width: 56 }, // 入口
              ]}
            />
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="whitespace-nowrap">业务域</TableHead>
                <TableHead>说明</TableHead>
                <TableHead className="whitespace-nowrap">能力</TableHead>
                <TableHead className={numericHead}>路由</TableHead>
                <TableHead className="whitespace-nowrap">最近活动</TableHead>
                <TableHead className={numericHead}>调用 24h</TableHead>
                <TableHead className={numericHead}>调用 7d</TableHead>
                <TableHead className={numericHead}>7d 错误</TableHead>
                <TableHead className="whitespace-nowrap">今日产出</TableHead>
                <TableHead className="whitespace-nowrap">状态</TableHead>
                <TableHead className="!text-center">入口</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedDomains.map((domain) => {
                const live = domain.status === 'live'
                const row = summary?.[domain.code]
                const hasSummary = live && summary !== null
                return (
                  <TableRow key={domain.code} className={live ? undefined : 'text-term-faint'}>
                    <TableCell className="font-medium">
                      <span className="block truncate">{domain.label}</span>
                    </TableCell>
                    <TableCell className="text-xs text-term-muted" title={domain.description}>
                      {/* 定高两行盒：line-clamp 直接落在 <td> 上会把 display 改成 -webkit-box，
                          单元格不再是 table-cell（border-separate 下不撑满行高）→ 该列比同行其他列矮一截；
                          且说明占 1 行/2 行时行高会抖动。故内层定高 2 行、外层居中。 */}
                      <span className="flex min-h-8 items-center">
                        <span className="line-clamp-2 leading-4">{domain.description}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-nowrap items-center gap-1">
                        {domain.capabilities.read && (
                          <Badge variant="outline" className="px-1.5 font-normal text-term-muted">
                            读
                          </Badge>
                        )}
                        {domain.capabilities.write && (
                          <Badge variant="outline" className="px-1.5 font-normal text-term-muted">
                            写
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={`${numericCell} text-term-muted`}>
                      {live ? domain.routeCount : <span className="text-term-faint">—</span>}
                    </TableCell>
                    <TableCell>
                      {row || hasSummary ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs">
                          <span
                            aria-hidden
                            className={`h-1.5 w-1.5 rounded-full bg-current ${FRESHNESS_STYLE[freshnessFor(row?.last_active_at)]}`}
                          />
                          <span className="text-term-muted">
                            {row ? formatRelativeTime(row.last_active_at) : '7 天内无调用'}
                          </span>
                        </span>
                      ) : (
                        <span className="text-term-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className={`${numericCell} text-term-muted`}
                      title={hasSummary ? `写 24h:${row?.writes_24h ?? 0}` : undefined}
                    >
                      {row?.calls_24h ?? (hasSummary ? 0 : <span className="text-term-faint">—</span>)}
                    </TableCell>
                    <TableCell
                      className={`${numericCell} text-term-muted`}
                      title={hasSummary ? `写 7d:${row?.writes_7d ?? 0}` : undefined}
                    >
                      {row?.calls_7d ?? (hasSummary ? 0 : <span className="text-term-faint">—</span>)}
                    </TableCell>
                    <TableCell
                      className={numericCell}
                      title={
                        row
                          ? `${row.errors_7d} 次错误 / ${row.calls_7d} 次调用`
                          : hasSummary
                            ? '7 天内无调用，错误率不可计算'
                            : undefined
                      }
                    >
                      {row ? (
                        <span
                          className={`font-mono tabular-nums ${
                            row.errors_7d > 0 ? 'text-term-neg' : 'text-term-muted'
                          }`}
                        >
                          {errorRateText(row.errors_7d, row.calls_7d)}
                        </span>
                      ) : hasSummary ? (
                        <span className="text-term-faint" title="7 天内无调用，错误率不可计算">
                          无调用
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
                            className={`whitespace-nowrap text-xs text-term-muted ${cell.mono ? 'font-mono tabular-nums' : ''}`}
                            title="今日产出(Agent 写入 / 提交 / 上传)"
                          >
                            {cell.text}
                          </span>
                        )
                      })()}
                    </TableCell>
                    <TableCell>
                      {live ? (
                        <StatusPill status="success" dot={false} label="已接入" />
                      ) : (
                        <StatusPill status="neutral" dot={false} label="规划中" />
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {domain.dashboardPath ? (
                        <Link
                          href={domain.dashboardPath}
                          aria-label={`打开${domain.label}`}
                          title={`前往${domain.label}工作台`}
                          className="u-focus inline-flex h-8 w-8 items-center justify-center rounded-none text-term-muted transition-colors hover:bg-term-hover hover:text-term-accent"
                        >
                          <ArrowUpRight className="h-4 w-4" aria-hidden />
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

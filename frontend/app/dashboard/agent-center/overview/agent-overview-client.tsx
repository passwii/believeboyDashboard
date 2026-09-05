'use client'

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
import { AGENT_DOMAINS } from '@/lib/agent-domains'

/**
 * Agent 中心 · 数据流总览（P2a）。
 *
 * 当前为「接入状态 + 入口跳转」静态矩阵,数据源为 AGENT_DOMAINS 注册表单一事实源;
 * 运行时聚合列(最近活动 / 24h·7d 调用量 / 错误率)等后端 domain-summary 端点(P2b)接入后点亮。
 * 产出域(A 档)排在前,呼应侧栏「Agent 中心」组叙事;规划中域沉底。
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

export default function AgentOverviewClient() {
  const liveCount = AGENT_DOMAINS.filter((d) => d.status === 'live').length

  return (
    <div className="w-full space-y-6">
      <PageHeader
        eyebrow="Agent 中心 · 数据流"
        title="数据流总览"
        description={`${AGENT_DOMAINS.length} 个业务域、${liveCount} 个已接入 —— Agent 员工在各业务域活动的归集点,点击入口前往对应工作台。`}
      />

      <div className="rounded-none border border-dashed border-term-border bg-term-panel px-4 py-3 text-xs leading-6 text-term-muted">
        运行时聚合列(最近活动 / 24h·7d 调用量 / 错误率)待后端 domain-summary
        聚合端点(P2b)接入后点亮;本页当前展示接入状态与入口跳转,详见
        docs/superpowers/plans/2026-09-05-agent-dataflow-overview/。
      </div>

      <DataTableCard>
        <DataTableCardHeader
          title="业务域活动矩阵"
          description="每行一个 Agent 业务域:能力、路由数与前端入口;产出域(客诉 / 巡检 / 报表)置顶"
        />
        <DataTableCardBody>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[180px]">业务域</TableHead>
                <TableHead>说明</TableHead>
                <TableHead className="w-[110px]">能力</TableHead>
                <TableHead className="w-[80px]">路由</TableHead>
                <TableHead className="w-[100px]">接入状态</TableHead>
                <TableHead className="w-[130px]">Dashboard 入口</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedDomains.map((domain) => {
                const live = domain.status === 'live'
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
                    <TableCell className="max-w-[420px] text-xs text-term-muted line-clamp-2">
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

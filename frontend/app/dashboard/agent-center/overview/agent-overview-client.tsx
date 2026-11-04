'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  formatRelativeTime,
  freshnessFor,
  type Freshness,
  useAgentDomainSummary,
} from '@/lib/hooks/use-agent-domain-summary'
import { useAgentProduction } from '@/lib/hooks/use-agent-production'
import { AGENT_DOMAINS } from '@/lib/agent-domains'
import styles from './agent-overview-warm.module.css'

/**
 * Agent 中心 · 数据流总览。
 *
 * 静态部分 = AGENT_DOMAINS 注册表(接入状态 / 能力 / 入口跳转,产出域置顶呼应侧栏叙事);
 * 运行时部分 = domain-summary 聚合(P2b 前端已预埋):最近活动(新鲜度灯)/ 24h·30d 调用量 / 30d 错误率,
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
  green: styles.freshnessPositive,
  yellow: styles.freshnessAccent,
  gray: styles.freshnessMuted,
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

function errorRateText(errors30d: number, calls30d: number): string {
  if (calls30d <= 0) return '—'
  return `${Math.round((errors30d / calls30d) * 100)}%`
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
    <div className={styles.page} data-warm-agent-overview="true">
      <section className={styles.panel} aria-labelledby="agent-overview-title">
        <header className={styles.panelHeader}>
          <h2 id="agent-overview-title" className={styles.panelTitle}>
            业务域活动矩阵
          </h2>
          <p className={styles.panelDescription}>
            {`共 ${AGENT_DOMAINS.length} 个业务域、${liveCount} 个已接入,产出域置顶。 「今日产出」为实时业务数据,运行时活动与 30d 错误率由 domain-summary 提供;已接入域在 30 天内无调用时显示 0 和「无调用」,接口不可用时显示「—」。`}
          </p>
        </header>
        <div
          className={styles.tableScroll}
          data-agent-overview-table-scroll
          role="region"
          aria-labelledby="agent-overview-title"
          tabIndex={0}
        >
          <table className={styles.table}>
            <colgroup>
              <col className={styles.colDomain} />
              <col className={styles.colDescription} />
              <col className={styles.colCapability} />
              <col className={styles.colRoute} />
              <col className={styles.colActivity} />
              <col className={styles.colCalls} />
              <col className={styles.colCalls} />
              <col className={styles.colErrors} />
              <col className={styles.colProduction} />
              <col className={styles.colStatus} />
              <col className={styles.colEntry} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">业务域</th>
                <th scope="col">说明</th>
                <th scope="col">能力</th>
                <th scope="col" className={styles.numeric}>
                  路由
                </th>
                <th scope="col">最近活动</th>
                <th scope="col" className={styles.numeric}>
                  调用 24h
                </th>
                <th scope="col" className={styles.numeric}>
                  调用 30d
                </th>
                <th scope="col" className={styles.numeric}>
                  30d 错误
                </th>
                <th scope="col">今日产出</th>
                <th scope="col">状态</th>
                <th scope="col" className={styles.center}>
                  入口
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedDomains.map((domain) => {
                const live = domain.status === 'live'
                const row = summary?.[domain.code]
                const hasSummary = live && summary !== null
                const productionValue = productionCell(domain.code, production)
                return (
                  <tr key={domain.code} className={live ? undefined : styles.plannedRow}>
                    <td>
                      <span className={styles.domainName}>{domain.label}</span>
                    </td>
                    <td className={styles.descriptionCell} title={domain.description}>
                      <span className={styles.descriptionText}>{domain.description}</span>
                    </td>
                    <td>
                      <div className={styles.capabilityList}>
                        {domain.capabilities.read && (
                          <span className={styles.capabilityBadge}>读</span>
                        )}
                        {domain.capabilities.write && (
                          <span className={styles.capabilityBadge}>写</span>
                        )}
                      </div>
                    </td>
                    <td className={`${styles.numeric} ${styles.mutedValue}`}>
                      {live ? domain.routeCount : <span className={styles.placeholder}>—</span>}
                    </td>
                    <td>
                      {row || hasSummary ? (
                        <span className={styles.freshness}>
                          <span
                            aria-hidden
                            className={`${styles.freshnessDot} ${FRESHNESS_STYLE[freshnessFor(row?.last_active_at)]}`}
                          />
                          <span>{row ? formatRelativeTime(row.last_active_at) : '30 天内无调用'}</span>
                        </span>
                      ) : (
                        <span className={styles.placeholder}>—</span>
                      )}
                    </td>
                    <td
                      className={`${styles.numeric} ${styles.mutedValue}`}
                      title={hasSummary ? `写 24h:${row?.writes_24h ?? 0}` : undefined}
                    >
                      {row?.calls_24h ?? (hasSummary ? 0 : <span className={styles.placeholder}>—</span>)}
                    </td>
                    <td
                      className={`${styles.numeric} ${styles.mutedValue}`}
                      title={hasSummary ? `写 30d:${row?.writes_30d ?? 0}` : undefined}
                    >
                      {row?.calls_30d ?? (hasSummary ? 0 : <span className={styles.placeholder}>—</span>)}
                    </td>
                    <td
                      className={styles.numeric}
                      title={
                        row
                          ? `${row.errors_30d} 次错误 / ${row.calls_30d} 次调用`
                          : hasSummary
                            ? '30 天内无调用，错误率不可计算'
                            : undefined
                      }
                    >
                      {row ? (
                        <span
                          className={row.errors_30d > 0 ? styles.negativeValue : styles.mutedValue}
                          data-tone={row.errors_30d > 0 ? 'negative' : 'muted'}
                        >
                          {errorRateText(row.errors_30d, row.calls_30d)}
                        </span>
                      ) : hasSummary ? (
                        <span
                          className={styles.placeholder}
                          title="30 天内无调用，错误率不可计算"
                        >
                          无调用
                        </span>
                      ) : (
                        <span className={styles.placeholder}>—</span>
                      )}
                    </td>
                    <td>
                      {productionValue ? (
                        <span
                          className={`${styles.productionText} ${productionValue.mono ? styles.productionNumeric : ''}`}
                          title="今日产出(Agent 写入 / 提交 / 上传)"
                        >
                          {productionValue.text}
                        </span>
                      ) : (
                        <span className={styles.placeholder}>—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`${styles.statusBadge} ${live ? styles.statusLive : styles.statusPlanned}`}
                      >
                        {live ? '已接入' : '规划中'}
                      </span>
                    </td>
                    <td className={styles.center}>
                      {domain.dashboardPath ? (
                        <Link
                          href={domain.dashboardPath}
                          aria-label={`打开${domain.label}`}
                          title={`前往${domain.label}工作台`}
                          className={styles.entryLink}
                        >
                          <ArrowUpRight size={16} aria-hidden />
                        </Link>
                      ) : (
                        <span className={styles.placeholder}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

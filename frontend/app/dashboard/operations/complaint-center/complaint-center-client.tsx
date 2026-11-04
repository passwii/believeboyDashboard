'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MessageSquare,
  TrendingUp,
} from 'lucide-react'

import { SingleDatePicker } from '@/components/ui/date-picker'
import { HeaderSlotBadge } from '@/components/terminal/header-filter-suite'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import {
  type CheckStatus,
  type ComplaintOverview,
  fetchComplaintOverview,
} from '@/lib/complaint-api'
import styles from './complaint-center-warm.module.css'

const LazyTrendChart = dynamic(
  () => import('./components/trend-chart').then((m) => m.ComplaintTrendChart),
  {
    ssr: false,
    loading: () => (
      <div className={styles.chartEmpty} role="status" aria-busy="true">
        正在加载趋势
      </div>
    ),
  }
)

const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  ok: '正常',
  login_page: '登录页',
  launch_fail: '启动失败',
  identity_mismatch: '身份不符',
}

const CHECK_STATUS_TONE: Record<CheckStatus, 'positive' | 'negative' | 'accent' | 'muted'> = {
  ok: 'positive',
  launch_fail: 'negative',
  identity_mismatch: 'accent',
  login_page: 'accent',
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getDayStart(d: Date | undefined): Date {
  const r = new Date(d ?? new Date())
  r.setHours(0, 0, 0, 0)
  return r
}

export default function ComplaintCenterClient() {
  const { notify } = useNotifications()
  const [date, setDate] = useState<Date>(new Date())
  const [overview, setOverview] = useState<ComplaintOverview | null>(null)
  const [loading, setLoading] = useState(true)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchComplaintOverview({ date: formatLocalDate(date), country: 'US' })
      setOverview(data)
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: `加载概览失败: ${(err as Error).message}`,
      })
    } finally {
      setLoading(false)
    }
  }, [date, notify])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const handleRefreshRef = useRef(loadOverview)
  handleRefreshRef.current = loadOverview
  useHeaderRefresh(() => handleRefreshRef.current(), { loading })

  const dateLabel = formatLocalDate(date)
  const isToday = useMemo(() => {
    const today = new Date()
    return (
      today.getFullYear() === date.getFullYear() &&
      today.getMonth() === date.getMonth() &&
      today.getDate() === date.getDate()
    )
  }, [date])

  const allFailed = overview?.projects.every((shop) => shop.check_status !== 'ok') ?? false
  const isEmpty = !loading && overview && overview.metrics.total_needs_reply === 0

  const headerControls = (
    <>
      <SingleDatePicker
        value={date}
        onChange={(next) => next && setDate(getDayStart(next))}
        className="h-10 w-[130px]"
      />
      <HeaderSlotBadge title={`${dateLabel}${isToday ? ' 今天' : ''}`}>
        {isToday ? '今天' : dateLabel}
      </HeaderSlotBadge>
    </>
  )

  const desktopSlot = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={headerControls} />
  )

  const mobileSummary = isToday ? '今天' : dateLabel
  const mobileControls = (
    <>
      <SingleDatePicker
        value={date}
        onChange={(next) => next && setDate(getDayStart(next))}
        className="h-10 w-full"
      />
      <HeaderSlotBadge title={`${dateLabel}${isToday ? ' 今天' : ''}`}>
        {isToday ? '今天' : dateLabel}
      </HeaderSlotBadge>
    </>
  )
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip summary={mobileSummary} controls={mobileControls} />
  )

  return (
    <>
      {desktopSlot}
      {mobileStrip}
      <div
        className={styles.page}
        data-testid="complaint-center-page"
        data-warm-complaint-center="true"
      >
        {loading ? (
          <div className={styles.loading} role="status" aria-busy="true">
            <span className={styles.loadingLabel}>正在加载客户消息概览</span>
            <div className={styles.skeletonGrid} aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div className={styles.skeletonMetric} key={index} />
              ))}
            </div>
            <div className={styles.skeletonPanel} aria-hidden="true" />
            <div className={styles.skeletonPanel} aria-hidden="true" />
          </div>
        ) : overview ? (
          <>
            <section className={styles.metricGrid} aria-label="客户消息指标">
              <Metric
                label="待回复"
                value={overview.metrics.total_needs_reply}
                icon={<MessageSquare size={16} />}
                tone="accent"
              />
              <Metric
                label="已解决"
                value={overview.metrics.total_resolved}
                icon={<CheckCircle2 size={16} />}
              />
              <Metric
                label="SLA 临期"
                value={overview.metrics.sla_due_soon}
                icon={<Clock size={16} />}
                tone={overview.metrics.sla_due_soon > 0 ? 'accent' : undefined}
              />
              <Metric
                label="已过期"
                value={overview.metrics.sla_overdue}
                icon={<AlertTriangle size={16} />}
              />
            </section>

            <section
              className={styles.panel}
              data-testid="complaint-trend-panel"
              data-warm-panel="true"
            >
              <header className={styles.panelHeader}>
                <div className={styles.panelHeading}>
                  <h2 className={styles.panelTitle}>近 30 天趋势</h2>
                  <p className={styles.panelDescription}>每日待回复客诉数</p>
                </div>
                <TrendingUp className={styles.panelIcon} size={16} aria-hidden="true" />
              </header>
              <div className={styles.panelBody}>
                {overview.trend.length > 0 ? (
                  <LazyTrendChart data={overview.trend} />
                ) : (
                  <div className={styles.chartEmpty}>暂无趋势数据</div>
                )}
              </div>
            </section>

            <section className={styles.panel} data-warm-panel="true">
              <header className={styles.panelHeader}>
                <div className={styles.panelHeading}>
                  <h2 className={styles.panelTitle}>店铺健康</h2>
                  <p className={styles.panelDescription}>
                    15 店铺巡检状态 · {dateLabel}
                    {isToday ? ' 今天' : ''}
                  </p>
                </div>
                <Link
                  href="/dashboard/operations/complaint-center/list"
                  className={styles.panelAction}
                >
                  查看全部客诉
                </Link>
              </header>
              <div className={styles.panelBody}>
                {isEmpty ? (
                  <div className={styles.emptyProject} role="status">
                    {allFailed && overview.projects.length > 0
                      ? '今日巡检启动失败，请检查 Agent 配置'
                      : isToday
                        ? '今日无待回复消息'
                        : `${dateLabel} 无待回复消息`}
                  </div>
                ) : (
                  <div className={styles.tableScroll} data-warm-table-scroll="true">
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>店铺</th>
                          <th>站点</th>
                          <th>巡检状态</th>
                          <th className={styles.numeric}>待回复</th>
                          <th className={styles.numeric}>已解决</th>
                          <th className={styles.numeric}>SLA 临期</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.projects.map((project) => (
                          <tr key={`${project.project_id}-${project.country}`}>
                            <td className={styles.projectName}>{project.project_name}</td>
                            <td>{project.country}</td>
                            <td>
                              <span
                                className={styles.statusText}
                                data-tone={CHECK_STATUS_TONE[project.check_status]}
                              >
                                {CHECK_STATUS_LABEL[project.check_status]}
                              </span>
                            </td>
                            <td className={styles.numeric}>{project.needs_reply}</td>
                            <td className={styles.numeric}>{project.resolved}</td>
                            <td className={styles.numeric}>
                              <span
                                className={project.sla_due_soon > 0 ? styles.dueSoon : undefined}
                              >
                                {project.sla_due_soon}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </>
  )
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string
  value: number
  icon: ReactNode
  tone?: 'accent'
}) {
  return (
    <div className={styles.metric} data-testid="complaint-metric" data-tone={tone}>
      <div className={styles.metricCopy}>
        <span className={styles.metricLabel}>{label}</span>
        <span className={styles.metricValue}>{value}</span>
      </div>
      <span className={styles.metricIcon} aria-hidden="true">
        {icon}
      </span>
    </div>
  )
}

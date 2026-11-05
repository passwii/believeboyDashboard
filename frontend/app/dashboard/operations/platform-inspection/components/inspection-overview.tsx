'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, ImageIcon } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { useNotifications } from '@/components/notifications'
import {
  fetchPeriodOverview,
  type InspectionOverview as InspectionOverviewType,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { AhrRatingBadge, getAhrRatingPresentation } from './ahr-rating'
import styles from '../platform-inspection-warm.module.css'

interface InspectionOverviewProps {
  periodId: number
  refreshKey?: number
  onSelectProject: (projectId: number) => void
}

type Tone = 'positive' | 'accent' | 'negative' | 'muted'

const STATUS_PRESENTATION: Record<string, { label: string; tone: Tone }> = {
  submitted: { label: '已提交', tone: 'positive' },
  draft: { label: '草稿', tone: 'accent' },
  overdue: { label: '已逾期', tone: 'negative' },
  pending: { label: '待填写', tone: 'muted' },
}

const SHIPPING_THRESHOLDS = {
  late_shipment_rate: { warning: 2, critical: 4 },
  valid_tracking_rate: { warning: 97, critical: 95, inverted: true },
  on_time_delivery_rate: { warning: 97, critical: 95, inverted: true },
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDatetime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDeadline(deadlineStr: string): { text: string; isOverdue: boolean } {
  const deadline = new Date(deadlineStr)
  const now = new Date()
  const isOverdue = now > deadline
  const text = deadline.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return { text, isOverdue }
}

type Severity = 'normal' | 'warning' | 'critical'

function getMetricSeverity(
  value: number | undefined | null,
  threshold: { warning: number; critical: number; inverted?: boolean } | undefined
): Severity {
  if (value === undefined || value === null || !threshold) return 'normal'
  if (threshold.inverted) {
    if (value <= threshold.critical) return 'critical'
    if (value <= threshold.warning) return 'warning'
    return 'normal'
  }
  if (value >= threshold.critical) return 'critical'
  if (value >= threshold.warning) return 'warning'
  return 'normal'
}

type CardSeverity = 'normal' | 'warning' | 'critical'

function getCardSeverity(item: InspectionOverviewType['items'][number]): CardSeverity {
  const ahrSeverity = getAhrRatingPresentation(item.account_health_rating).severity
  if (ahrSeverity === 'critical') return 'critical'
  if ((item.compliance_total ?? 0) >= 3) return 'critical'
  if (
    getMetricSeverity(item.late_shipment_rate, SHIPPING_THRESHOLDS.late_shipment_rate) ===
    'critical'
  ) {
    return 'critical'
  }
  if (
    getMetricSeverity(item.valid_tracking_rate, SHIPPING_THRESHOLDS.valid_tracking_rate) ===
    'critical'
  ) {
    return 'critical'
  }
  if (
    getMetricSeverity(item.on_time_delivery_rate, SHIPPING_THRESHOLDS.on_time_delivery_rate) ===
    'critical'
  ) {
    return 'critical'
  }

  if (ahrSeverity === 'warning') return 'warning'
  if ((item.compliance_total ?? 0) >= 1) return 'warning'
  if (
    getMetricSeverity(item.late_shipment_rate, SHIPPING_THRESHOLDS.late_shipment_rate) ===
    'warning'
  ) {
    return 'warning'
  }
  if (
    getMetricSeverity(item.valid_tracking_rate, SHIPPING_THRESHOLDS.valid_tracking_rate) ===
    'warning'
  ) {
    return 'warning'
  }
  if (
    getMetricSeverity(item.on_time_delivery_rate, SHIPPING_THRESHOLDS.on_time_delivery_rate) ===
    'warning'
  ) {
    return 'warning'
  }
  if (
    (item.negative_feedback ?? 0) > 0 ||
    (item.a2z_claims ?? 0) > 0 ||
    (item.chargeback_claims ?? 0) > 0
  ) {
    return 'warning'
  }

  return 'normal'
}

const SEVERITY_RANK: Record<CardSeverity, number> = {
  critical: 0,
  warning: 1,
  normal: 2,
}

function MetricBadge({
  label,
  value,
  unit = '%',
  threshold,
}: {
  label: string
  value: number | undefined | null
  unit?: string
  threshold?: { warning: number; critical: number; inverted?: boolean }
}) {
  if (value === undefined || value === null) {
    return (
      <div className={styles.metric}>
        <span>{label}</span>
        <span className={styles.metricValue}>--</span>
      </div>
    )
  }

  const severity = getMetricSeverity(value, threshold)
  return (
    <div className={styles.metric} data-severity={severity}>
      <span>{label}</span>
      <span className={styles.metricValue}>
        {severity !== 'normal' ? <AlertTriangle size={12} aria-hidden="true" /> : null}
        {value}
        {unit}
      </span>
    </div>
  )
}

function StatusSummaryIndicator({ content }: { content: string | null | undefined }) {
  if (!content) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={styles.iconButton}
          aria-label="查看状态说明"
        >
          <FileText size={15} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={styles.popover}
        onClick={(event) => event.stopPropagation()}
      >
        <p className={styles.detailSummary}>{content}</p>
      </PopoverContent>
    </Popover>
  )
}

function ScreenshotCount({ count, onPreview }: { count: number; onPreview: () => void }) {
  if (count === 0) return null

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onPreview()
      }}
      className={styles.screenshotButton}
    >
      <ImageIcon size={13} aria-hidden="true" />
      {count}张截图
    </button>
  )
}

interface ProjectCardProps {
  item: InspectionOverviewType['items'][number]
  onClick: () => void
  onPreviewScreenshot: (url: string) => void
}

function ProjectCard({ item, onClick, onPreviewScreenshot }: ProjectCardProps) {
  const status = STATUS_PRESENTATION[item.status] ?? STATUS_PRESENTATION.pending
  const cardSeverity = getCardSeverity(item)
  const screenshotCount = item.screenshots?.length ?? 0
  const serviceTotal =
    (item.negative_feedback ?? 0) + (item.a2z_claims ?? 0) + (item.chargeback_claims ?? 0)

  return (
    <article
      className={styles.projectCard}
      data-testid="inspection-project-card"
      data-warm-panel="true"
      data-severity={cardSeverity}
    >
      <button
        type="button"
        onClick={onClick}
        className={styles.cardEdit}
        aria-label={`编辑 ${item.project_name}`}
      />
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{item.project_name}</h2>
        <span className={styles.statusBadge} data-tone={status.tone}>
          {status.label}
        </span>
      </header>

      <div className={styles.cardBody}>
        <section className={styles.cardSection}>
          <span className={styles.sectionLabel}>账号健康</span>
          <div className={styles.badgeRow}>
            {item.account_health_rating ? (
              <AhrRatingBadge rating={item.account_health_rating} showCode />
            ) : (
              <span className={styles.statusBadge}>AHR --</span>
            )}
            <span
              className={styles.serviceBadge}
              data-tone={serviceTotal > 0 ? 'accent' : 'positive'}
            >
              <span>客服</span>
              <strong>{serviceTotal}</strong>
            </span>
          </div>
        </section>

        <section className={styles.cardSection}>
          <span className={styles.sectionLabel}>配送 &amp; 合规</span>
          <div className={styles.metricGrid}>
            <MetricBadge
              label="迟发率"
              value={item.late_shipment_rate}
              threshold={SHIPPING_THRESHOLDS.late_shipment_rate}
            />
            <MetricBadge
              label="有效追踪"
              value={item.valid_tracking_rate}
              threshold={SHIPPING_THRESHOLDS.valid_tracking_rate}
            />
            <MetricBadge
              label="准时交付"
              value={item.on_time_delivery_rate}
              threshold={SHIPPING_THRESHOLDS.on_time_delivery_rate}
            />
            <div
              className={styles.metric}
              data-severity={
                (item.compliance_total ?? 0) >= 3
                  ? 'critical'
                  : (item.compliance_total ?? 0) >= 1
                    ? 'warning'
                    : 'normal'
              }
            >
              <span>合规问题</span>
              <span className={styles.metricValue}>
                {(item.compliance_total ?? 0) > 0 ? (
                  <AlertTriangle size={12} aria-hidden="true" />
                ) : null}
                {item.compliance_total ?? '--'}
              </span>
            </div>
          </div>
        </section>
      </div>

      <footer className={styles.cardFooter}>
        <p className={styles.submittedBy}>
          {item.submitted_by ? (
            <>
              {item.submitted_by}
              {item.submitted_at ? ` · ${formatDatetime(item.submitted_at)}` : ''}
            </>
          ) : (
            <span className={styles.unsubmitted}>未提交</span>
          )}
        </p>
        <div className={styles.cardActions}>
          <ScreenshotCount
            count={screenshotCount}
            onPreview={() => {
              const first = item.screenshots?.[0]
              const firstUrl =
                typeof first === 'object' &&
                first !== null &&
                'url' in first &&
                typeof (first as { url: unknown }).url === 'string'
                  ? (first as { url: string }).url
                  : undefined
              if (firstUrl) onPreviewScreenshot(firstUrl)
            }}
          />
          <StatusSummaryIndicator content={item.status_summary} />
        </div>
      </footer>
    </article>
  )
}

function ProjectCardSkeleton() {
  return (
    <div className={styles.projectCard} aria-hidden="true">
      <div className={styles.cardHeader}>
        <div className={`${styles.skeletonSummary} ${styles.skeletonCardTitle}`} />
        <div className={`${styles.skeletonSummary} ${styles.skeletonCardBadge}`} />
      </div>
      <div className={styles.cardBody}>
        <div className={`${styles.skeletonSummary} ${styles.skeletonCardBody}`} />
        <div className={styles.metricGrid}>
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className={`${styles.skeletonSummary} ${styles.skeletonCardMetric}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default function InspectionOverview({
  periodId,
  onSelectProject,
  refreshKey,
}: InspectionOverviewProps) {
  const { notify } = useNotifications()
  const [overview, setOverview] = useState<InspectionOverviewType | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  useEffect(() => {
    async function loadOverview() {
      setLoading(true)
      try {
        const data = await fetchPeriodOverview(periodId)
        setOverview(data)
      } catch (error) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(error, '获取巡检概览失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadOverview()
  }, [periodId, refreshKey, notify])

  const sortedItems = useMemo(() => {
    if (!overview) return []
    return [...overview.items].sort(
      (a, b) => SEVERITY_RANK[getCardSeverity(a)] - SEVERITY_RANK[getCardSeverity(b)]
    )
  }, [overview])

  if (loading) {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span>正在加载巡检概览</span>
        <div className={styles.skeletonSummary} aria-hidden="true" />
        <div className={styles.projectGrid} aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <ProjectCardSkeleton key={index} />
          ))}
        </div>
      </div>
    )
  }

  if (!overview) {
    return (
      <div className={styles.empty} role="status">
        暂无巡检数据
      </div>
    )
  }

  const { text: deadlineText, isOverdue } = formatDeadline(overview.period.deadline)
  const progressPercent =
    overview.total_projects > 0 ? (overview.submitted_count / overview.total_projects) * 100 : 0
  const warningCount = overview.items.filter((item) => getCardSeverity(item) === 'warning').length
  const criticalCount = overview.items.filter(
    (item) => getCardSeverity(item) === 'critical'
  ).length
  const hasAlerts = overview.overdue_count > 0 || criticalCount > 0 || warningCount > 0

  return (
    <div
      className={styles.overview}
      data-testid="inspection-overview"
      data-warm-inspection-overview="true"
    >
      <section className={styles.summaryPanel} data-overdue={isOverdue}>
        <div className={styles.summaryTop}>
          <div className={styles.summaryHeading}>
            <h2 className={styles.summaryTitle}>
              {formatDate(overview.period.week_start)} - {formatDate(overview.period.week_end)}
            </h2>
            <p className={styles.summaryMeta}>
              截止时间: {deadlineText}
              {isOverdue ? <span className={styles.overdue}>(已逾期)</span> : null}
            </p>
          </div>
          <span
            className={styles.statusBadge}
            data-tone={isOverdue ? 'negative' : overview.submitted_count === overview.total_projects ? 'positive' : 'accent'}
          >
            {overview.submitted_count} / {overview.total_projects} 已提交
          </span>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label="巡检提交进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPercent)}
        >
          <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
        </div>
      </section>

      {hasAlerts ? (
        <div className={styles.alert} role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <p>
            {overview.overdue_count > 0 ? (
              <span className={styles.alertWarning}>{overview.overdue_count} 个项目已逾期</span>
            ) : null}
            {overview.overdue_count > 0 && criticalCount > 0 ? (
              <span className={styles.alertSep}> · </span>
            ) : null}
            {criticalCount > 0 ? (
              <span className={styles.alertCritical}>{criticalCount} 个项目严重异常</span>
            ) : null}
            {criticalCount > 0 && warningCount > 0 ? (
              <span className={styles.alertSep}> · </span>
            ) : null}
            {warningCount > 0 ? (
              <span className={styles.alertWarning}>{warningCount} 个项目存在风险</span>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className={styles.projectGrid}>
        {sortedItems.map((item) => (
          <div key={item.project_id}>
            <ProjectCard
              item={item}
              onClick={() => onSelectProject(item.project_id)}
              onPreviewScreenshot={setPreviewImage}
            />
          </div>
        ))}
      </div>

      {previewImage ? (
        <PortraitScreenshotDialog
          open={Boolean(previewImage)}
          onOpenChange={(open) => !open && setPreviewImage(null)}
          src={previewImage}
          alt="巡检截图预览"
        />
      ) : null}
    </div>
  )
}

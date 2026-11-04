'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Eye, ImageIcon, Loader2 } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { useNotifications } from '@/components/notifications'
import {
  fetchInspectionHistory,
  fetchPeriods,
  fetchReport,
  type InspectionHistoryItem,
  type InspectionPeriod,
  type InspectionReport,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { AhrRatingBadge } from './ahr-rating'
import styles from '../platform-inspection-warm.module.css'

interface InspectionHistoryProps {
  periodId: number
  refreshKey?: number
}

const STATUS_PRESENTATION: Record<
  string,
  { label: string; tone: 'positive' | 'accent' | 'negative' | 'muted' }
> = {
  submitted: { label: '已提交', tone: 'positive' },
  draft: { label: '草稿', tone: 'accent' },
  overdue: { label: '已逾期', tone: 'negative' },
  pending: { label: '待填写', tone: 'muted' },
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span>{label}</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  )
}

function DetailSheet({
  item,
  report,
  loading,
  open,
  onClose,
}: {
  item: InspectionHistoryItem | null
  report: InspectionReport | null
  loading: boolean
  open: boolean
  onClose: () => void
}) {
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className={styles.drawer} data-warm-inspection-drawer="true">
        <SheetHeader className={styles.drawerHeader}>
          <SheetTitle className={styles.drawerTitle}>
            {item?.project_name || '报告详情'}
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className={styles.tableStatus} role="status" aria-busy="true">
            <Loader2 className={styles.spin} size={24} aria-hidden="true" />
            正在加载报告详情
          </div>
        ) : report ? (
          <div className={styles.drawerBody}>
            <section className={styles.detailSection}>
              <div className={`${styles.detailSurface} ${styles.detailGrid}`}>
                <DetailRow
                  label="周期"
                  value={`${item?.week_start ?? '-'} - ${item?.week_end ?? '-'}`}
                />
                <DetailRow
                  label="状态"
                  value={
                    <span
                      className={styles.statusBadge}
                      data-tone={STATUS_PRESENTATION[item?.status || '']?.tone ?? 'muted'}
                    >
                      {STATUS_PRESENTATION[item?.status || '']?.label ?? item?.status}
                    </span>
                  }
                />
                {item?.submitted_by ? (
                  <DetailRow label="提交人" value={item.submitted_by} />
                ) : null}
                {item?.submitted_at ? (
                  <DetailRow label="提交时间" value={formatDateTime(item.submitted_at)} />
                ) : null}
              </div>
            </section>

            {report.health_data && Object.keys(report.health_data).length > 0 ? (
              <section className={styles.detailSection}>
                <h3 className={styles.detailTitle}>账户健康指标</h3>
                <div className={`${styles.detailSurface} ${styles.detailGrid}`}>
                  {report.health_data.account_health_rating ? (
                    <div className={styles.detailRow}>
                      <span>AHR</span>
                      <AhrRatingBadge rating={report.health_data.account_health_rating} compact />
                    </div>
                  ) : null}
                  {report.health_data.negative_feedback !== undefined ? (
                    <DetailRow label="负面反馈" value={report.health_data.negative_feedback} />
                  ) : null}
                  {report.health_data.a2z_claims !== undefined ? (
                    <DetailRow label="亚马逊 A-to-Z" value={report.health_data.a2z_claims} />
                  ) : null}
                  {report.health_data.chargeback_claims !== undefined ? (
                    <DetailRow label="信用卡拒付" value={report.health_data.chargeback_claims} />
                  ) : null}
                  {report.health_data.late_shipment_rate !== undefined ? (
                    <DetailRow
                      label="迟发率"
                      value={`${report.health_data.late_shipment_rate}%`}
                    />
                  ) : null}
                  {report.health_data.pre_fulfillment_cancel_rate !== undefined ? (
                    <DetailRow
                      label="配送前取消率"
                      value={`${report.health_data.pre_fulfillment_cancel_rate}%`}
                    />
                  ) : null}
                  {report.health_data.valid_tracking_rate !== undefined ? (
                    <DetailRow
                      label="有效追踪率"
                      value={`${report.health_data.valid_tracking_rate}%`}
                    />
                  ) : null}
                  {report.health_data.on_time_delivery_rate !== undefined ? (
                    <DetailRow
                      label="准时交付率"
                      value={`${report.health_data.on_time_delivery_rate}%`}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}

            {report.compliance_data && Object.keys(report.compliance_data).length > 0 ? (
              <section className={styles.detailSection}>
                <h3 className={styles.detailTitle}>政策与合规</h3>
                <div className={`${styles.detailSurface} ${styles.detailGrid}`}>
                  {report.compliance_data.ip_infringement !== undefined ? (
                    <DetailRow
                      label="涉嫌侵犯知识产权"
                      value={report.compliance_data.ip_infringement}
                    />
                  ) : null}
                  {report.compliance_data.ip_complaints !== undefined ? (
                    <DetailRow label="知识产权投诉" value={report.compliance_data.ip_complaints} />
                  ) : null}
                  {report.compliance_data.product_authenticity_complaints !== undefined ? (
                    <DetailRow
                      label="商品真实性买家投诉"
                      value={report.compliance_data.product_authenticity_complaints}
                    />
                  ) : null}
                  {report.compliance_data.product_condition_complaints !== undefined ? (
                    <DetailRow
                      label="商品状况买家投诉"
                      value={report.compliance_data.product_condition_complaints}
                    />
                  ) : null}
                  {report.compliance_data.food_product_safety !== undefined ? (
                    <DetailRow
                      label="食品和商品安全问题"
                      value={report.compliance_data.food_product_safety}
                    />
                  ) : null}
                  {report.compliance_data.listing_policy_violations !== undefined ? (
                    <DetailRow
                      label="上架政策违规"
                      value={report.compliance_data.listing_policy_violations}
                    />
                  ) : null}
                  {report.compliance_data.restricted_product_violations !== undefined ? (
                    <DetailRow
                      label="违反受限商品政策"
                      value={report.compliance_data.restricted_product_violations}
                    />
                  ) : null}
                  {report.compliance_data.review_policy_violations !== undefined ? (
                    <DetailRow
                      label="违反买家商品评论政策"
                      value={report.compliance_data.review_policy_violations}
                    />
                  ) : null}
                  {report.compliance_data.other_policy_violations !== undefined ? (
                    <DetailRow
                      label="其他违反政策"
                      value={report.compliance_data.other_policy_violations}
                    />
                  ) : null}
                  {report.compliance_data.regulatory_compliance !== undefined ? (
                    <DetailRow
                      label="监管合规性"
                      value={report.compliance_data.regulatory_compliance}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}

            {report.status_summary ? (
              <section className={styles.detailSection}>
                <h3 className={styles.detailTitle}>状态说明</h3>
                <div className={styles.detailSurface}>
                  <p className={styles.detailSummary}>{report.status_summary}</p>
                </div>
              </section>
            ) : null}

            {report.screenshots && report.screenshots.length > 0 ? (
              <section className={styles.detailSection}>
                <h3 className={styles.detailTitle}>截图 ({report.screenshots.length})</h3>
                <div className={styles.screenshotGrid}>
                  {report.screenshots.map((screenshot) => (
                    <figure key={screenshot.id} className={styles.screenshotCard}>
                      <button
                        type="button"
                        className={styles.screenshotPreview}
                        onClick={() => setPreviewImage(screenshot.url)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={screenshot.url}
                          alt={screenshot.filename}
                          className={styles.screenshotImage}
                        />
                      </button>
                      {screenshot.caption ? (
                        <figcaption className={styles.caption}>{screenshot.caption}</figcaption>
                      ) : null}
                    </figure>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className={styles.tableStatus} role="status">
            暂无报告数据
          </div>
        )}
      </SheetContent>

      {previewImage ? (
        <PortraitScreenshotDialog
          open={Boolean(previewImage)}
          onOpenChange={(nextOpen) => !nextOpen && setPreviewImage(null)}
          src={previewImage}
          alt="截图预览"
        />
      ) : null}
    </Sheet>
  )
}

export default function InspectionHistory({ periodId, refreshKey }: InspectionHistoryProps) {
  const { notify } = useNotifications()
  const [history, setHistory] = useState<InspectionHistoryItem[]>([])
  const [periods, setPeriods] = useState<InspectionPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<number>(periodId)
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<InspectionHistoryItem | null>(null)
  const [detailReport, setDetailReport] = useState<InspectionReport | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [tablePreviewImage, setTablePreviewImage] = useState<string | null>(null)

  useEffect(() => {
    async function loadPeriods() {
      try {
        const data = await fetchPeriods(100)
        setPeriods(data.items)
      } catch (error) {
        console.error('Failed to load periods:', error)
      }
    }
    void loadPeriods()
  }, [refreshKey])

  useEffect(() => {
    async function loadHistory() {
      setLoading(true)
      try {
        const data = await fetchInspectionHistory({
          periodId: selectedPeriodId,
          limit: 100,
        })
        setHistory(data.items)
      } catch (error) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(error, '获取历史记录失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadHistory()
  }, [selectedPeriodId, notify, refreshKey])

  const handleViewDetail = async (item: InspectionHistoryItem) => {
    setSelectedItem(item)
    setDetailReport(null)
    setDetailOpen(true)
    setDetailLoading(true)

    try {
      const report = await fetchReport(item.period_id, item.project_id)
      setDetailReport(report)
    } catch (error) {
      notify({
        type: 'error',
        title: '加载失败',
        message: normalizeErrorMessage(error, '获取报告详情失败'),
      })
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div
      className={styles.history}
      data-testid="inspection-history"
      data-warm-inspection-history="true"
    >
      <div className={styles.periodBar}>
        <label className={styles.periodLabel} htmlFor="inspection-period-select">
          选择周期
        </label>
        <select
          id="inspection-period-select"
          value={selectedPeriodId}
          onChange={(event) => setSelectedPeriodId(Number(event.target.value))}
          className={styles.periodSelect}
        >
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {period.week_start} - {period.week_end}
            </option>
          ))}
        </select>
      </div>

      <section className={styles.panel} data-warm-panel="true">
        {loading ? (
          <div className={styles.tableStatus} role="status" aria-busy="true">
            <Loader2 className={styles.spin} size={24} aria-hidden="true" />
            正在加载历史记录
          </div>
        ) : history.length === 0 ? (
          <div className={styles.tableStatus} role="status">
            暂无历史记录
          </div>
        ) : (
          <div className={styles.tableScroll} data-warm-table-scroll="true">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>项目</th>
                  <th>状态</th>
                  <th>AHR</th>
                  <th>合规问题</th>
                  <th>状态说明</th>
                  <th>截图</th>
                  <th>提交人</th>
                  <th>提交时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => {
                  const status = STATUS_PRESENTATION[item.status] ?? STATUS_PRESENTATION.pending
                  return (
                    <tr key={item.id}>
                      <td className={styles.tableProject}>{item.project_name}</td>
                      <td>
                        <span className={styles.statusBadge} data-tone={status.tone}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        {item.account_health_rating ? (
                          <AhrRatingBadge rating={item.account_health_rating} compact />
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>{item.compliance_total ?? '-'}</td>
                      <td>
                        {item.status_summary ? (
                          <span className={styles.tableSummary} title={item.status_summary}>
                            {item.status_summary}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>
                        {item.screenshots && item.screenshots.length > 0 ? (
                          <div className={styles.thumbRow}>
                            {item.screenshots.slice(0, 4).map((screenshot) => (
                              <button
                                key={screenshot.id}
                                type="button"
                                className={styles.thumbButton}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setTablePreviewImage(screenshot.url)
                                }}
                                title={screenshot.caption || '查看截图'}
                                aria-label={screenshot.caption || '查看截图'}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={screenshot.thumbnail_url || screenshot.url}
                                  alt={screenshot.caption || '截图'}
                                  className={styles.thumbImage}
                                />
                              </button>
                            ))}
                            {item.screenshots.length > 4 ? (
                              <span className={styles.moreThumbs}>
                                +{item.screenshots.length - 4}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <ImageIcon size={14} aria-hidden="true" />
                        )}
                      </td>
                      <td>{item.submitted_by || '-'}</td>
                      <td>{formatDateTime(item.submitted_at)}</td>
                      <td>
                        <WarmButton
                          variant="quiet"
                          onClick={() => void handleViewDetail(item)}
                        >
                          <Eye size={14} aria-hidden="true" />
                          查看
                        </WarmButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <DetailSheet
        item={selectedItem}
        report={detailReport}
        loading={detailLoading}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          setSelectedItem(null)
        }}
      />

      {tablePreviewImage ? (
        <PortraitScreenshotDialog
          open={Boolean(tablePreviewImage)}
          onOpenChange={(open) => !open && setTablePreviewImage(null)}
          src={tablePreviewImage}
          alt="截图预览"
        />
      ) : null}
    </div>
  )
}

'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react'
import { AlertTriangle, FileUp, Loader2, Save, Send, X } from 'lucide-react'

import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { useNotifications } from '@/components/notifications'
import {
  deleteScreenshot,
  fetchInspectionTemplate,
  fetchReport,
  saveReport,
  submitReport,
  uploadScreenshot,
  type ComplianceData,
  type HealthData,
  type InspectionTemplateField,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import styles from '../platform-inspection-warm.module.css'

interface InspectionFormProps {
  periodId: number
  projectId: number
  open: boolean
  onClose: () => void
  onBack: () => void
  onSubmitSuccess: () => void
}

interface ScreenshotItem {
  id?: number
  url: string
  filename: string
  caption: string
  isUploading: boolean
  isNew: boolean
}

interface ThresholdWarning {
  metric: string
  value: number
  threshold: number
  severity: 'warning' | 'critical'
  message: string
}

const AHR_OPTIONS = [
  { value: 'Healthy', label: 'Healthy (健康)' },
  { value: 'Good', label: 'Good (良好)' },
  { value: 'At Risk', label: 'At Risk (有风险)' },
  { value: 'Critical', label: 'Critical (危险)' },
]

function ScreenshotUploadZone({
  onUpload,
}: {
  onUpload: (file: File) => Promise<void>
}) {
  const [dragActive, setDragActive] = useState(false)
  const [pasteActive, setPasteActive] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('仅支持图片文件')
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('文件大小不能超过 10MB')
        return
      }

      setError(null)
      setUploading(true)
      try {
        await onUpload(file)
      } finally {
        setUploading(false)
      }
    },
    [onUpload]
  )

  useEffect(() => {
    if (!pasteActive || uploading) return

    const handlePaste = (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.items ?? []).find((item) =>
        item.type.startsWith('image/')
      )
      const file = image?.getAsFile()
      if (!file) return
      event.preventDefault()
      void processFile(file)
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [pasteActive, processFile, uploading])

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void processFile(file)
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    if (uploading) return
    const file = event.dataTransfer.files?.[0]
    if (file) void processFile(file)
  }

  return (
    <div className={styles.uploadRow}>
      <WarmButton
        variant="secondary"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <FileUp size={14} aria-hidden="true" />
        上传文件
      </WarmButton>
      <div
        className={styles.dropZone}
        data-active={dragActive || pasteActive}
        role="button"
        tabIndex={0}
        aria-pressed={pasteActive}
        aria-disabled={uploading}
        onClick={() => {
          if (!uploading) setPasteActive((current) => !current)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (!uploading) setPasteActive((current) => !current)
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {uploading
          ? '上传中...'
          : pasteActive
            ? '粘贴模式已激活，按 Ctrl+V 粘贴图片'
            : '点击此处激活粘贴上传，或拖拽图片到这里'}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        disabled={uploading}
        onChange={handleInputChange}
        className={styles.fileInput}
      />
      {error ? (
        <p className={styles.uploadError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function MetricInput({
  label,
  value,
  onChange,
  unit = '',
  placeholder = '0',
  step = '1',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  unit?: string
  placeholder?: string
  step?: string
}) {
  const id = `inspection-${label.replace(/\s+/g, '-')}`
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.metricInputRow}>
        <input
          id={id}
          type="number"
          step={step}
          min="0"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={styles.input}
        />
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </div>
    </div>
  )
}

function MetricsGrid({ children }: { children: ReactNode }) {
  return <div className={styles.metricsGrid}>{children}</div>
}

const DEFAULT_HEALTH: HealthData = {
  negative_feedback: 0,
  a2z_claims: 0,
  chargeback_claims: 0,
  late_shipment_rate: 0,
  pre_fulfillment_cancel_rate: 0,
  valid_tracking_rate: 100,
  on_time_delivery_rate: 100,
}

const DEFAULT_COMPLIANCE: ComplianceData = {
  ip_infringement: 0,
  ip_complaints: 0,
  product_authenticity_complaints: 0,
  product_condition_complaints: 0,
  food_product_safety: 0,
  listing_policy_violations: 0,
  restricted_product_violations: 0,
  review_policy_violations: 0,
  other_policy_violations: 0,
  regulatory_compliance: 0,
}

type TemplateData = {
  health_fields: InspectionTemplateField[]
  service_performance_fields: InspectionTemplateField[]
  shipping_performance_fields: InspectionTemplateField[]
  compliance_fields: InspectionTemplateField[]
}

function checkFieldWarnings(
  fields: InspectionTemplateField[],
  data: Record<string, unknown>
): ThresholdWarning[] {
  const warnings: ThresholdWarning[] = []
  for (const field of fields) {
    const value = data[field.key]
    if (typeof value !== 'number') continue
    const warningThreshold = field.threshold_warning ?? null
    const criticalThreshold = field.threshold_critical ?? null
    if (warningThreshold === null) continue

    let triggered = false
    if (field.threshold_direction === 'above' && value >= warningThreshold) triggered = true
    if (field.threshold_direction === 'below' && value <= warningThreshold) triggered = true

    if (triggered) {
      warnings.push({
        metric: field.label,
        value,
        threshold: warningThreshold,
        severity:
          criticalThreshold !== null &&
          ((field.threshold_direction === 'above' && value >= criticalThreshold) ||
            (field.threshold_direction === 'below' && value <= criticalThreshold))
            ? 'critical'
            : 'warning',
        message: `${field.label}: ${value}${field.unit || ''}`,
      })
    }
  }
  return warnings
}

export default function InspectionForm({
  periodId,
  projectId,
  open,
  onClose,
  onSubmitSuccess,
}: InspectionFormProps) {
  const { notify } = useNotifications()
  const [template, setTemplate] = useState<TemplateData | null>(null)

  const [formData, setFormData] = useState<{
    health_data: HealthData
    compliance_data: ComplianceData
    status_summary: string
  }>({
    health_data: { ...DEFAULT_HEALTH },
    compliance_data: { ...DEFAULT_COMPLIANCE },
    status_summary: '',
  })

  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([])
  const [reportId, setReportId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<ThresholdWarning[]>([])

  useEffect(() => {
    async function loadTemplate() {
      try {
        const data = await fetchInspectionTemplate()
        setTemplate(data)
      } catch (error) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(error, '获取表单模板失败'),
        })
      }
    }
    void loadTemplate()
  }, [notify])

  useEffect(() => {
    if (!open || !projectId) return

    async function loadReportData() {
      setLoading(true)
      try {
        const report = await fetchReport(periodId, projectId)
        if (report) {
          setReportId(report.id)
          setFormData({
            health_data: { ...DEFAULT_HEALTH, ...(report.health_data || {}) },
            compliance_data: { ...DEFAULT_COMPLIANCE, ...(report.compliance_data || {}) },
            status_summary: report.status_summary || '',
          })
          setScreenshots(
            report.screenshots.map((screenshot) => ({
              id: screenshot.id,
              url: screenshot.url,
              filename: screenshot.filename,
              caption: screenshot.caption || '',
              isUploading: false,
              isNew: false,
            }))
          )
        } else {
          setReportId(null)
          setFormData({
            health_data: { ...DEFAULT_HEALTH },
            compliance_data: { ...DEFAULT_COMPLIANCE },
            status_summary: '',
          })
          setScreenshots([])
        }
      } catch (error) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(error, '获取报告失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadReportData()
  }, [periodId, projectId, open, notify])

  useEffect(() => {
    if (!template) return
    const nextWarnings: ThresholdWarning[] = [
      ...checkFieldWarnings(
        template.service_performance_fields,
        formData.health_data as unknown as Record<string, unknown>
      ),
      ...checkFieldWarnings(
        template.shipping_performance_fields,
        formData.health_data as unknown as Record<string, unknown>
      ),
      ...checkFieldWarnings(
        template.compliance_fields,
        formData.compliance_data as unknown as Record<string, unknown>
      ),
    ]
    setWarnings(nextWarnings)
  }, [formData, template])

  const handleHealthChange = (key: keyof HealthData, value: string | number) => {
    setFormData((previous) => ({
      ...previous,
      health_data: { ...previous.health_data, [key]: value },
    }))
  }

  const handleComplianceChange = (key: keyof ComplianceData, value: number) => {
    setFormData((previous) => ({
      ...previous,
      compliance_data: { ...previous.compliance_data, [key]: value },
    }))
  }

  const handleSaveDraft = async () => {
    setSaving(true)
    try {
      const result = await saveReport(periodId, projectId, {
        health_data: formData.health_data,
        compliance_data: formData.compliance_data,
        status_summary: formData.status_summary || undefined,
        screenshot_ids: screenshots.filter((screenshot) => screenshot.id).map((screenshot) => screenshot.id!),
      })
      setReportId(result.id)
      notify({ type: 'success', title: '草稿已保存' })
      onSubmitSuccess()
    } catch (error) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(error, '保存草稿失败'),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async () => {
    setSaving(true)
    try {
      const result = await saveReport(periodId, projectId, {
        health_data: formData.health_data,
        compliance_data: formData.compliance_data,
        status_summary: formData.status_summary || undefined,
        screenshot_ids: screenshots.filter((screenshot) => screenshot.id).map((screenshot) => screenshot.id!),
      })
      setReportId(result.id)
    } catch (error) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(error, '保存报告失败'),
      })
      setSaving(false)
      return
    }
    setSaving(false)

    setSubmitting(true)
    try {
      await submitReport(periodId, projectId)
      notify({ type: 'success', title: '报告已提交' })
      onSubmitSuccess()
    } catch (error) {
      notify({
        type: 'error',
        title: '提交失败',
        message: normalizeErrorMessage(error, '提交报告失败'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleUploadScreenshot = useCallback(
    async (file: File) => {
      let targetReportId: number | null = reportId

      if (!targetReportId) {
        try {
          const result = await saveReport(periodId, projectId, {
            health_data: formData.health_data,
            compliance_data: formData.compliance_data,
            status_summary: formData.status_summary || undefined,
          })
          targetReportId = result.id
          setReportId(result.id)
        } catch (error) {
          notify({
            type: 'error',
            title: '保存失败',
            message: normalizeErrorMessage(error, '保存报告失败'),
          })
          return
        }
      }

      const previewUrl = URL.createObjectURL(file)
      setScreenshots((previous) => [
        ...previous,
        { url: previewUrl, filename: file.name, caption: '', isUploading: true, isNew: true },
      ])

      try {
        const uploaded = await uploadScreenshot(file, targetReportId)
        setScreenshots((previous) =>
          previous.map((screenshot) =>
            screenshot.url === previewUrl
              ? {
                  id: uploaded.id,
                  url: uploaded.url,
                  filename: uploaded.filename,
                  caption: uploaded.caption || '',
                  isUploading: false,
                  isNew: false,
                }
              : screenshot
          )
        )
      } catch (error) {
        setScreenshots((previous) => previous.filter((screenshot) => screenshot.url !== previewUrl))
        notify({
          type: 'error',
          title: '上传失败',
          message: normalizeErrorMessage(error, '上传截图失败'),
        })
      }
    },
    [reportId, projectId, periodId, formData, notify]
  )

  const handleDeleteScreenshot = useCallback(
    async (index: number) => {
      const screenshot = screenshots[index]
      if (!screenshot) return

      if (screenshot.id && !screenshot.isNew) {
        try {
          await deleteScreenshot(screenshot.id)
        } catch (error) {
          notify({
            type: 'error',
            title: '删除失败',
            message: normalizeErrorMessage(error, '删除截图失败'),
          })
          return
        }
      }

      setScreenshots((previous) => previous.filter((_, currentIndex) => currentIndex !== index))
    },
    [screenshots, notify]
  )

  const handleCaptionChange = useCallback((index: number, caption: string) => {
    setScreenshots((previous) =>
      previous.map((screenshot, currentIndex) =>
        currentIndex === index ? { ...screenshot, caption } : screenshot
      )
    )
  }, [])

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className={styles.dialog}>
          <div className={styles.formBody} role="status" aria-busy="true">
            <span>正在加载巡检报告</span>
            <div className={styles.metricsGrid}>
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className={`${styles.formSection} ${styles.formSkeleton}`}
                />
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className={styles.dialog}>
        <DialogHeader className={styles.dialogHeader}>
          <DialogTitle className={styles.dialogTitle}>巡检报告</DialogTitle>
        </DialogHeader>

        <div
          className={styles.formBody}
          data-testid="inspection-form-dialog"
          data-warm-inspection-form="true"
        >
          {warnings.length > 0 ? (
            <div className={styles.warningPanel}>
              <div className={styles.warningTitle}>
                <AlertTriangle size={18} aria-hidden="true" />
                检测到 {warnings.length} 个指标异常
              </div>
              {warnings.map((warning, index) => (
                <p key={index} className={styles.warningLine}>
                  {warning.message} (阈值: {warning.threshold})
                </p>
              ))}
            </div>
          ) : null}

          <section className={styles.formSection} data-warm-panel="true">
            <h2 className={styles.formSectionTitle}>账户健康指标</h2>
            <WarmSelect
              id="inspection-ahr"
              label="Account Health Rating (账户健康评级)"
              value={formData.health_data.account_health_rating || ''}
              options={AHR_OPTIONS}
              onChange={(value) => handleHealthChange('account_health_rating', value)}
              placeholder="请选择评级"
            />
          </section>

          <section className={styles.formSection} data-warm-panel="true">
            <h2 className={styles.formSectionTitle}>客户服务绩效</h2>
            <MetricsGrid>
              <MetricInput
                label="负面反馈"
                value={formData.health_data.negative_feedback?.toString() ?? '0'}
                onChange={(value) => handleHealthChange('negative_feedback', parseInt(value) || 0)}
              />
              <MetricInput
                label="亚马逊 A-to-Z"
                value={formData.health_data.a2z_claims?.toString() ?? '0'}
                onChange={(value) => handleHealthChange('a2z_claims', parseInt(value) || 0)}
              />
              <MetricInput
                label="信用卡拒付"
                value={formData.health_data.chargeback_claims?.toString() ?? '0'}
                onChange={(value) => handleHealthChange('chargeback_claims', parseInt(value) || 0)}
              />
            </MetricsGrid>
          </section>

          <section className={styles.formSection} data-warm-panel="true">
            <h2 className={styles.formSectionTitle}>配送绩效</h2>
            <MetricsGrid>
              <MetricInput
                label="迟发率"
                value={formData.health_data.late_shipment_rate?.toString() ?? '0'}
                onChange={(value) =>
                  handleHealthChange('late_shipment_rate', parseFloat(value) || 0)
                }
                unit="%"
                step="0.01"
              />
              <MetricInput
                label="配送前取消率"
                value={formData.health_data.pre_fulfillment_cancel_rate?.toString() ?? '0'}
                onChange={(value) =>
                  handleHealthChange('pre_fulfillment_cancel_rate', parseFloat(value) || 0)
                }
                unit="%"
                step="0.01"
              />
              <MetricInput
                label="有效追踪率"
                value={formData.health_data.valid_tracking_rate?.toString() ?? '100'}
                onChange={(value) =>
                  handleHealthChange('valid_tracking_rate', parseFloat(value) || 0)
                }
                unit="%"
                step="0.01"
                placeholder="100"
              />
              <MetricInput
                label="准时交付率"
                value={formData.health_data.on_time_delivery_rate?.toString() ?? '100'}
                onChange={(value) =>
                  handleHealthChange('on_time_delivery_rate', parseFloat(value) || 0)
                }
                unit="%"
                step="0.01"
                placeholder="100"
              />
            </MetricsGrid>
          </section>

          <section className={styles.formSection} data-warm-panel="true">
            <h2 className={styles.formSectionTitle}>政策与合规</h2>
            <MetricsGrid>
              {[
                ['ip_infringement', '涉嫌侵犯知识产权'],
                ['ip_complaints', '知识产权投诉'],
                ['product_authenticity_complaints', '商品真实性买家投诉'],
                ['product_condition_complaints', '商品状况买家投诉'],
                ['food_product_safety', '食品和商品安全问题'],
                ['listing_policy_violations', '上架政策违规'],
                ['restricted_product_violations', '违反受限商品政策'],
                ['review_policy_violations', '违反买家商品评论政策'],
                ['other_policy_violations', '其他违反政策'],
                ['regulatory_compliance', '监管合规性'],
              ].map(([key, label]) => (
                <MetricInput
                  key={key}
                  label={label}
                  value={formData.compliance_data[key as keyof ComplianceData]?.toString() ?? '0'}
                  onChange={(value) =>
                    handleComplianceChange(key as keyof ComplianceData, parseInt(value) || 0)
                  }
                />
              ))}
            </MetricsGrid>
          </section>

          <section className={styles.formSection} data-warm-panel="true">
            <h2 className={styles.formSectionTitle}>截图上传</h2>
            <ScreenshotUploadZone onUpload={handleUploadScreenshot} />

            {screenshots.length > 0 ? (
              <div className={styles.screenshotEditGrid}>
                {screenshots.map((screenshot, index) => (
                  <div key={screenshot.url} className={styles.screenshotEditCard}>
                    <button
                      type="button"
                      className={styles.removeScreenshot}
                      onClick={() => void handleDeleteScreenshot(index)}
                      aria-label={`删除截图 ${screenshot.filename}`}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>

                    {screenshot.isUploading ? (
                      <div className={styles.uploading}>
                        <Loader2 className={styles.spin} size={18} aria-hidden="true" />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={styles.previewButton}
                        onClick={() => setPreviewImage(screenshot.url)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={screenshot.url}
                          alt={screenshot.filename}
                          className={styles.editImage}
                        />
                      </button>
                    )}

                    <input
                      className={styles.captionInput}
                      placeholder="添加描述..."
                      value={screenshot.caption}
                      onChange={(event) => handleCaptionChange(index, event.target.value)}
                      aria-label={`截图描述 ${screenshot.filename}`}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className={styles.formSection} data-warm-panel="true">
            <label className={styles.fieldLabel} htmlFor="inspection-status-summary">
              状态说明
            </label>
            <textarea
              id="inspection-status-summary"
              className={styles.textarea}
              placeholder="描述账户当前状态..."
              rows={4}
              value={formData.status_summary}
              onChange={(event) =>
                setFormData((previous) => ({ ...previous, status_summary: event.target.value }))
              }
            />
          </section>
        </div>

        <DialogFooter className={styles.dialogFooter}>
          <WarmButton
            variant="secondary"
            onClick={() => void handleSaveDraft()}
            disabled={saving || submitting}
            loading={saving}
            loadingLabel="正在保存草稿"
          >
            {!saving ? <Save size={14} aria-hidden="true" /> : null}
            保存草稿
          </WarmButton>
          <WarmButton
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={saving || submitting}
            loading={submitting}
            loadingLabel="正在提交报告"
          >
            {!submitting ? <Send size={14} aria-hidden="true" /> : null}
            提交报告
          </WarmButton>
        </DialogFooter>

        {previewImage ? (
          <PortraitScreenshotDialog
            open={Boolean(previewImage)}
            onOpenChange={(nextOpen) => !nextOpen && setPreviewImage(null)}
            src={previewImage}
            alt="截图预览"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

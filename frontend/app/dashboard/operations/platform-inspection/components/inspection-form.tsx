'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { UploadZone } from '@/components/ui/upload-zone'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { useNotifications } from '@/components/notifications'
import { Save, Send, AlertTriangle, X } from 'lucide-react'
import {
  fetchReport,
  saveReport,
  submitReport,
  uploadScreenshot,
  deleteScreenshot,
  fetchInspectionTemplate,
  type HealthData,
  type ComplianceData,
  type InspectionTemplateField,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'

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
  onChange: (v: string) => void
  unit?: string
  placeholder?: string
  step?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step={step}
          min="0"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-24"
        />
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}

function MetricsGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{children}</div>
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
      } catch (e) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(e, '获取表单模板失败'),
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
            report.screenshots.map((s) => ({
              id: s.id,
              url: s.url,
              filename: s.filename,
              caption: s.caption || '',
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
      } catch (e) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(e, '获取报告失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadReportData()
  }, [periodId, projectId, open, notify])

  useEffect(() => {
    if (!template) return
    const w: ThresholdWarning[] = [
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
    setWarnings(w)
  }, [formData, template])

  const handleHealthChange = (key: keyof HealthData, value: string | number) => {
    setFormData((prev) => ({ ...prev, health_data: { ...prev.health_data, [key]: value } }))
  }

  const handleComplianceChange = (key: keyof ComplianceData, value: number) => {
    setFormData((prev) => ({ ...prev, compliance_data: { ...prev.compliance_data, [key]: value } }))
  }

  const handleSaveDraft = async () => {
    setSaving(true)
    try {
      const result = await saveReport(periodId, projectId, {
        health_data: formData.health_data,
        compliance_data: formData.compliance_data,
        status_summary: formData.status_summary || undefined,
        screenshot_ids: screenshots.filter((s) => s.id).map((s) => s.id!),
      })
      setReportId(result.id)
      notify({ type: 'success', title: '草稿已保存' })
      onSubmitSuccess()
    } catch (e) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(e, '保存草稿失败'),
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
        screenshot_ids: screenshots.filter((s) => s.id).map((s) => s.id!),
      })
      setReportId(result.id)
    } catch (e) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(e, '保存报告失败'),
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
    } catch (e) {
      notify({
        type: 'error',
        title: '提交失败',
        message: normalizeErrorMessage(e, '提交报告失败'),
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
        } catch (e) {
          notify({
            type: 'error',
            title: '保存失败',
            message: normalizeErrorMessage(e, '保存报告失败'),
          })
          return
        }
      }

      const previewUrl = URL.createObjectURL(file)
      setScreenshots((prev) => [
        ...prev,
        { url: previewUrl, filename: file.name, caption: '', isUploading: true, isNew: true },
      ])

      try {
        const uploaded = await uploadScreenshot(file, targetReportId)
        setScreenshots((prev) =>
          prev.map((s) =>
            s.url === previewUrl
              ? {
                  id: uploaded.id,
                  url: uploaded.url,
                  filename: uploaded.filename,
                  caption: uploaded.caption || '',
                  isUploading: false,
                  isNew: false,
                }
              : s
          )
        )
      } catch (e) {
        setScreenshots((prev) => prev.filter((s) => s.url !== previewUrl))
        notify({
          type: 'error',
          title: '上传失败',
          message: normalizeErrorMessage(e, '上传截图失败'),
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
        } catch (e) {
          notify({
            type: 'error',
            title: '删除失败',
            message: normalizeErrorMessage(e, '删除截图失败'),
          })
          return
        }
      }

      setScreenshots((prev) => prev.filter((_, i) => i !== index))
    },
    [screenshots, notify]
  )

  const handleCaptionChange = useCallback((index: number, caption: string) => {
    setScreenshots((prev) => prev.map((s, i) => (i === index ? { ...s, caption } : s)))
  }, [])

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl">
          <div className="space-y-4 py-8">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-4 w-20 rounded bg-term-raised" />
                  <div className="h-9 w-full rounded border" />
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[calc(100vh-3rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>巡检报告</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4 animate-fade-slide-up">
          {/* Threshold warnings */}
          {warnings.length > 0 && (
            <div className="rounded-none border border-term-warn/30 bg-term-warn/5 p-4">
              <div className="flex items-center gap-2 text-term-warn">
                <AlertTriangle className="h-5 w-5" />
                <span className="font-medium">检测到 {warnings.length} 个指标异常</span>
              </div>
              <div className="mt-2 space-y-1">
                {warnings.map((w, i) => (
                  <p key={i} className="text-sm text-term-warn">
                    {w.message} (阈值: {w.threshold})
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* 1. 账户健康评级 */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">账户健康指标</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  Account Health Rating (账户健康评级)
                </Label>
                <Select
                  value={formData.health_data.account_health_rating || ''}
                  onValueChange={(v) => handleHealthChange('account_health_rating', v)}
                >
                  <SelectTrigger className="h-9 w-48">
                    <SelectValue placeholder="请选择评级" />
                  </SelectTrigger>
                  <SelectContent>
                    {AHR_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* 2. 客户服务绩效 */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">客户服务绩效</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricsGrid>
                <MetricInput
                  label="负面反馈"
                  value={formData.health_data.negative_feedback?.toString() ?? '0'}
                  onChange={(v) => handleHealthChange('negative_feedback', parseInt(v) || 0)}
                />
                <MetricInput
                  label="亚马逊 A-to-Z"
                  value={formData.health_data.a2z_claims?.toString() ?? '0'}
                  onChange={(v) => handleHealthChange('a2z_claims', parseInt(v) || 0)}
                />
                <MetricInput
                  label="信用卡拒付"
                  value={formData.health_data.chargeback_claims?.toString() ?? '0'}
                  onChange={(v) => handleHealthChange('chargeback_claims', parseInt(v) || 0)}
                />
              </MetricsGrid>
            </CardContent>
          </Card>

          {/* 3. 配送绩效 */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">配送绩效</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricsGrid>
                <MetricInput
                  label="迟发率"
                  value={formData.health_data.late_shipment_rate?.toString() ?? '0'}
                  onChange={(v) => handleHealthChange('late_shipment_rate', parseFloat(v) || 0)}
                  unit="%"
                  step="0.01"
                />
                <MetricInput
                  label="配送前取消率"
                  value={formData.health_data.pre_fulfillment_cancel_rate?.toString() ?? '0'}
                  onChange={(v) =>
                    handleHealthChange('pre_fulfillment_cancel_rate', parseFloat(v) || 0)
                  }
                  unit="%"
                  step="0.01"
                />
                <MetricInput
                  label="有效追踪率"
                  value={formData.health_data.valid_tracking_rate?.toString() ?? '100'}
                  onChange={(v) => handleHealthChange('valid_tracking_rate', parseFloat(v) || 0)}
                  unit="%"
                  step="0.01"
                  placeholder="100"
                />
                <MetricInput
                  label="准时交付率"
                  value={formData.health_data.on_time_delivery_rate?.toString() ?? '100'}
                  onChange={(v) => handleHealthChange('on_time_delivery_rate', parseFloat(v) || 0)}
                  unit="%"
                  step="0.01"
                  placeholder="100"
                />
              </MetricsGrid>
            </CardContent>
          </Card>

          {/* 4. 政策与合规 */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">政策与合规</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricsGrid>
                <MetricInput
                  label="涉嫌侵犯知识产权"
                  value={formData.compliance_data.ip_infringement?.toString() ?? '0'}
                  onChange={(v) => handleComplianceChange('ip_infringement', parseInt(v) || 0)}
                />
                <MetricInput
                  label="知识产权投诉"
                  value={formData.compliance_data.ip_complaints?.toString() ?? '0'}
                  onChange={(v) => handleComplianceChange('ip_complaints', parseInt(v) || 0)}
                />
                <MetricInput
                  label="商品真实性买家投诉"
                  value={
                    formData.compliance_data.product_authenticity_complaints?.toString() ?? '0'
                  }
                  onChange={(v) =>
                    handleComplianceChange('product_authenticity_complaints', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="商品状况买家投诉"
                  value={formData.compliance_data.product_condition_complaints?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('product_condition_complaints', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="食品和商品安全问题"
                  value={formData.compliance_data.food_product_safety?.toString() ?? '0'}
                  onChange={(v) => handleComplianceChange('food_product_safety', parseInt(v) || 0)}
                />
                <MetricInput
                  label="上架政策违规"
                  value={formData.compliance_data.listing_policy_violations?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('listing_policy_violations', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="违反受限商品政策"
                  value={formData.compliance_data.restricted_product_violations?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('restricted_product_violations', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="违反买家商品评论政策"
                  value={formData.compliance_data.review_policy_violations?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('review_policy_violations', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="其他违反政策"
                  value={formData.compliance_data.other_policy_violations?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('other_policy_violations', parseInt(v) || 0)
                  }
                />
                <MetricInput
                  label="监管合规性"
                  value={formData.compliance_data.regulatory_compliance?.toString() ?? '0'}
                  onChange={(v) =>
                    handleComplianceChange('regulatory_compliance', parseInt(v) || 0)
                  }
                />
              </MetricsGrid>
            </CardContent>
          </Card>

          {/* Screenshot Upload Card */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">截图上传</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <UploadZone
                accept="image/*"
                maxSize={10}
                onUpload={handleUploadScreenshot}
                showPreview={false}
              />

              {screenshots.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {screenshots.map((screenshot, index) => (
                    <div
                      key={screenshot.url}
                      className="group relative rounded-none border border-border/70 bg-term-raised p-2"
                    >
                      <button
                        type="button"
                        onClick={() => handleDeleteScreenshot(index)}
                        className="absolute right-2 top-2 z-10 rounded-full bg-slate-200/80 p-1 opacity-0 transition-opacity hover:bg-slate-300 group-hover:opacity-100 dark:bg-slate-700/80 dark:hover:bg-slate-600"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>

                      {screenshot.isUploading ? (
                        <div className="flex h-32 items-center justify-center">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        </div>
                      ) : (
                        <div
                          className="relative h-32 cursor-pointer overflow-hidden rounded"
                          onClick={() => setPreviewImage(screenshot.url)}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={screenshot.url}
                            alt={screenshot.filename}
                            className="h-full w-full object-cover"
                          />
                        </div>
                      )}

                      <Input
                        placeholder="添加描述..."
                        value={screenshot.caption}
                        onChange={(e) => handleCaptionChange(index, e.target.value)}
                        className="mt-2 h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Status Summary Card */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">状态说明</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="描述账户当前状态..."
                rows={4}
                value={formData.status_summary}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, status_summary: e.target.value }))
                }
              />
            </CardContent>
          </Card>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={handleSaveDraft} disabled={saving || submitting}>
            {saving ? (
              <div className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            保存草稿
          </Button>
          <Button onClick={handleSubmit} disabled={saving || submitting}>
            {submitting ? (
              <div className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            提交报告
          </Button>
        </DialogFooter>

        {previewImage && (
          <PortraitScreenshotDialog
            open={!!previewImage}
            onOpenChange={(o) => !o && setPreviewImage(null)}
            src={previewImage}
            alt="截图预览"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

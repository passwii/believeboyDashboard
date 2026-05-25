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
import { Switch } from '@/components/ui/switch'
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
import {
  Save,
  Send,
  AlertTriangle,
  X,
} from 'lucide-react'
import {
  fetchReport,
  saveReport,
  submitReport,
  uploadScreenshot,
  deleteScreenshot,
  fetchInspectionTemplate,
  type HealthData,
  type ComplianceData,
  type InspectionScreenshot,
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
}: {
  label: string
  value: string
  onChange: (v: string) => void
  unit?: string
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="0.01"
          min="0"
          max="100"
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

function MetricsRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
      {children}
    </div>
  )
}

const DEFAULT_HEALTH: HealthData = {
  odr: 0,
  late_shipment_rate: 0,
  pre_fulfillment_cancel_rate: 0,
  valid_tracking_rate: 0,
  on_time_delivery_rate: 0,
}

const DEFAULT_COMPLIANCE: ComplianceData = {
  policy_violations: 0,
  ip_complaints: 0,
  restricted_product_warnings: 0,
  listing_suppressed_count: 0,
  account_deactivation_risk: false,
}

export default function InspectionForm({
  periodId,
  projectId,
  open,
  onClose,
  onSubmitSuccess,
}: InspectionFormProps) {
  const { notify } = useNotifications()
  const [template, setTemplate] = useState<{
    health_fields: InspectionTemplateField[]
    compliance_fields: InspectionTemplateField[]
  } | null>(null)

  // Form data
  const [formData, setFormData] = useState<{
    health_data: HealthData
    compliance_data: ComplianceData
    status_summary: string
  }>({
    health_data: { ...DEFAULT_HEALTH },
    compliance_data: { ...DEFAULT_COMPLIANCE },
    status_summary: '',
  })

  // Screenshots
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([])
  const [reportId, setReportId] = useState<number | null>(null)

  // UI states
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<ThresholdWarning[]>([])

  // Load template
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

  // Load existing report when projectId or dialog open changes
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
          // Reset for new report
          setReportId(null)
          setFormData({ health_data: { ...DEFAULT_HEALTH }, compliance_data: { ...DEFAULT_COMPLIANCE }, status_summary: '' })
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

  // Calculate threshold warnings when form data changes
  useEffect(() => {
    if (!template) return

    const newWarnings: ThresholdWarning[] = []

    // Check health fields thresholds
    template.health_fields.forEach((field) => {
      const value = formData.health_data[field.key as keyof HealthData]
      if (typeof value === 'number' && field.threshold_warning !== undefined) {
        if (field.threshold_direction === 'higher_is_worse') {
          if (value > field.threshold_warning) {
            newWarnings.push({
              metric: field.label,
              value,
              threshold: field.threshold_warning,
              severity: 'warning',
              message: `${field.label} 超过阈值 ${field.threshold_warning}${field.unit || ''}`,
            })
          }
        }
      }
    })

    setWarnings(newWarnings)
  }, [formData, template])

  const handleHealthChange = (key: keyof HealthData, value: string | number | boolean) => {
    setFormData((prev) => ({
      ...prev,
      health_data: { ...prev.health_data, [key]: value },
    }))
  }

  const handleComplianceChange = (key: keyof ComplianceData, value: string | number | boolean) => {
    setFormData((prev) => ({
      ...prev,
      compliance_data: { ...prev.compliance_data, [key]: value },
    }))
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
    // Save first if no report exists
    if (!reportId) {
      setSaving(true)
      try {
        const result = await saveReport(periodId, projectId, {
          health_data: formData.health_data,
          compliance_data: formData.compliance_data,
          status_summary: formData.status_summary || undefined,
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
    }

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

  const handleUploadScreenshot = useCallback(async (file: File) => {
    let targetReportId: number | null = reportId

    // Need a report ID to attach screenshot — save draft first if needed
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
    const tempEntry = { url: previewUrl, filename: file.name, caption: '', isUploading: true, isNew: true }
    setScreenshots((prev) => [...prev, tempEntry])

    try {
      const uploaded = await uploadScreenshot(file, targetReportId)
      setScreenshots((prev) =>
        prev.map((s) =>
          s.url === previewUrl
            ? { id: uploaded.id, url: uploaded.url, filename: uploaded.filename, caption: uploaded.caption || '', isUploading: false, isNew: false }
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
  }, [reportId, projectId, periodId, formData, notify])

  const handleDeleteScreenshot = useCallback(async (index: number) => {
    const screenshot = screenshots[index]
    if (!screenshot) return

    // If it's an existing screenshot, delete from server
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
  }, [screenshots, notify])

  const handleCaptionChange = useCallback((index: number, caption: string) => {
    setScreenshots((prev) =>
      prev.map((s, i) => (i === index ? { ...s, caption } : s))
    )
  }, [])

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-2xl">
          <div className="space-y-4 py-8">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-4 w-20 rounded bg-[hsl(var(--surface-subtle))]" />
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
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[calc(100vh-3rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>巡检报告</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Threshold warnings */}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
                <span className="font-medium">
                  检测到 {warnings.length} 个指标异常
                </span>
              </div>
              <div className="mt-2 space-y-1">
                {warnings.map((w, i) => (
                  <p key={i} className="text-sm text-amber-600 dark:text-amber-500">
                    {w.metric}: {w.value}
                    {w.threshold !== undefined && ` (阈值: ${w.threshold})`}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Account Health Card */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">账户健康指标</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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

              <MetricsRow>
                <MetricInput
                  label="ODR (订单缺陷率)"
                  value={formData.health_data.odr?.toString() || ''}
                  onChange={(v) => handleHealthChange('odr', parseFloat(v) || 0)}
                  unit="%"
                />
                <MetricInput
                  label="迟发率"
                  value={formData.health_data.late_shipment_rate?.toString() || ''}
                  onChange={(v) => handleHealthChange('late_shipment_rate', parseFloat(v) || 0)}
                  unit="%"
                />
                <MetricInput
                  label="预履行取消率"
                  value={formData.health_data.pre_fulfillment_cancel_rate?.toString() || ''}
                  onChange={(v) => handleHealthChange('pre_fulfillment_cancel_rate', parseFloat(v) || 0)}
                  unit="%"
                />
                <MetricInput
                  label="有效追踪率"
                  value={formData.health_data.valid_tracking_rate?.toString() || ''}
                  onChange={(v) => handleHealthChange('valid_tracking_rate', parseFloat(v) || 0)}
                  unit="%"
                />
                <MetricInput
                  label="准时送达率"
                  value={formData.health_data.on_time_delivery_rate?.toString() || ''}
                  onChange={(v) => handleHealthChange('on_time_delivery_rate', parseFloat(v) || 0)}
                  unit="%"
                />
              </MetricsRow>
            </CardContent>
          </Card>

          {/* Compliance Card */}
          <Card className="dashboard-surface">
            <CardHeader>
              <CardTitle className="text-base">政策合规</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <MetricsRow>
                <MetricInput
                  label="政策违规数"
                  value={formData.compliance_data.policy_violations?.toString() || ''}
                  onChange={(v) => handleComplianceChange('policy_violations', parseInt(v) || 0)}
                />
                <MetricInput
                  label="IP投诉"
                  value={formData.compliance_data.ip_complaints?.toString() || ''}
                  onChange={(v) => handleComplianceChange('ip_complaints', parseInt(v) || 0)}
                />
                <MetricInput
                  label="受限商品警告"
                  value={formData.compliance_data.restricted_product_warnings?.toString() || ''}
                  onChange={(v) => handleComplianceChange('restricted_product_warnings', parseInt(v) || 0)}
                />
                <MetricInput
                  label="被抑制Listing数"
                  value={formData.compliance_data.listing_suppressed_count?.toString() || ''}
                  onChange={(v) => handleComplianceChange('listing_suppressed_count', parseInt(v) || 0)}
                />
              </MetricsRow>

              <div className="flex items-center gap-3 rounded-lg border border-border/70 p-4">
                <div className="flex-1">
                  <Label className="text-sm font-medium">账户停用风险</Label>
                  <p className="text-xs text-muted-foreground">
                    是否存在导致账户可能被停用的严重问题
                  </p>
                </div>
                <Switch
                  checked={formData.compliance_data.account_deactivation_risk || false}
                  onCheckedChange={(checked) =>
                    handleComplianceChange('account_deactivation_risk', checked)
                  }
                />
              </div>
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
              />

              {screenshots.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {screenshots.map((screenshot, index) => (
                    <div
                      key={screenshot.url}
                      className="group relative rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-2"
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
                  setFormData((prev) => ({
                    ...prev,
                    status_summary: e.target.value,
                  }))
                }
              />
            </CardContent>
          </Card>
        </div>

        <DialogFooter className="sticky bottom-0 border-t bg-background pt-4">
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={saving || submitting}
          >
            {saving ? (
              <div className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            保存草稿
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || submitting}
          >
            {submitting ? (
              <div className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            提交报告
          </Button>
        </DialogFooter>

        {/* Image preview dialog */}
        {previewImage && (
          <PortraitScreenshotDialog
            open={!!previewImage}
            onOpenChange={(open) => !open && setPreviewImage(null)}
            src={previewImage}
            alt="截图预览"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
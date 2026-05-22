'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  FileText,
  RefreshCw,
  Minus,
  X,
  FileX,
  Upload,
  FileUp,
  File,
  Check,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
} from '@/components/ui/data-card'
import { ProjectSelect } from '@/components/dashboard/console/project-select'
import { CountrySelect } from '@/components/dashboard/console/country-select'
import { cn } from '@/lib/utils'

// ─── Types ───────────────────────────────────────────────────────────────────

type AvailableReport = {
  report_id: number
  project_name: string
  country: string
  report_month: string
  has_summary_pdf: boolean
  pdf_url: string | null  // R2 URL for direct access
  pdf_uploaded_at: string | null
  pt3_calculation_complete: boolean
  pt4_calculation_complete: boolean
  status: string
  pdf_file_missing?: boolean
  // Reconciliation status from history
  reconciled?: boolean
  reconcile_match_rate?: number | null
  reconcile_record_id?: number | null
}

type ReconcileItem = {
  field_name: string
  db_value: number | null
  pdf_value: number | null
  match: boolean
  difference: number | null
  difference_percent: number | null
}

type ReconcileResult = {
  summary: {
    db_total_income: number | null
    db_total_expense: number | null
    db_net_amount: number | null
    pdf_total_income: number | null
    pdf_total_expense: number | null
    pdf_net_amount: number | null
  }
  total_items: number
  matched_items: number
  mismatched_items: number
  missing_items: number
  match_rate: number
  items: ReconcileItem[]
  record_id: number | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELD_NAME_LABELS: Record<string, string> = {
  FBA_product_sales: 'FBA 销售额',
  FBA_product_sale_refunds: 'FBA 销售额退款',
  FBA_selling_fees: 'FBA 销售佣金',
  FBA_transaction_fees: 'FBA 派送费',
  FBA_inventory_and_inbound_services: 'FBA 库存和入库服务费',
  service_fees: '服务费',
  advertising_costs: '广告成本',
  total_income: '合计收入',
  total_expense: '合计费用',
}

const COUNTRY_LABELS: Record<string, string> = {
  US: '美国站',
  DE: '德国站',
  UK: '英国站',
  JP: '日本站',
  FR: '法国站',
  IT: '意大利站',
  ES: '西班牙站',
  CA: '加拿大站',
  MX: '墨西哥站',
  AU: '澳大利亚站',
  IN: '印度站',
  BR: '巴西站',
  NL: '荷兰站',
  SE: '瑞典站',
  PL: '波兰站',
  TR: '土耳其站',
  SG: '新加坡站',
  AE: '阿联酋站',
  BE: '比利时站',
  SA: '沙特站',
}

const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD',
  DE: 'EUR',
  UK: 'GBP',
  JP: 'JPY',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  CA: 'CAD',
  MX: 'MXN',
  AU: 'AUD',
  IN: 'INR',
  BR: 'BRL',
  NL: 'EUR',
  SE: 'SEK',
  PL: 'PLN',
  TR: 'TRY',
  SG: 'SGD',
  AE: 'AED',
  BE: 'EUR',
  SA: 'SAR',
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatCurrency(value: number | null | undefined, country: string): string {
  if (value === null || value === undefined) return '-'
  const currency = COUNTRY_CURRENCY[country] ?? 'EUR'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value)
}

function formatMonth(monthStr: string): string {
  const [year, m] = monthStr.split('-')
  return `${year}年${m}月`
}

// ─── Status Indicator Component ──────────────────────────────────────────────

type ReconcileStatus = 'pending' | 'reconciling' | 'success' | 'warning' | 'error' | 'reconciled'

function getReconcileStatus(
  result: ReconcileResult | null,
  reconciling: boolean,
  reconciled?: boolean,
  matchRate?: number | null
): ReconcileStatus {
  if (reconciling) return 'reconciling'

  // First check if we have a live result
  if (result) {
    if (result.match_rate === 100) return 'success'
    if (result.match_rate >= 70) return 'warning'
    return 'error'
  }

  // Then check if it was reconciled before (from history)
  if (reconciled && matchRate !== undefined && matchRate !== null) {
    if (matchRate === 100) return 'success'
    if (matchRate >= 70) return 'warning'
    return 'error'
  }

  return 'pending'
}

function ReconcileStatusIcon({ status }: { status: ReconcileStatus }) {
  switch (status) {
    case 'pending':
      return <Minus className='h-5 w-5 text-muted-foreground/40' />
    case 'reconciling':
      return <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
    case 'success':
      return <CheckCircle2 className='h-5 w-5 text-emerald-500' />
    case 'warning':
      return <AlertCircle className='h-5 w-5 text-amber-500' />
    case 'error':
      return <XCircle className='h-5 w-5 text-red-500' />
  }
}

// ─── PDF Upload Panel Component ────────────────────────────────────────────────

type PDFUploadState = 'idle' | 'uploading' | 'success' | 'error'

function PDFUploadPanel({
  report,
  onUploadSuccess,
  onClose,
  errorMessage,
}: {
  report: AvailableReport
  onUploadSuccess: () => void
  onClose: () => void
  errorMessage?: string  // NEW: external error to display
}) {
  const { notify } = useNotifications()
  const [uploadState, setUploadState] = useState<PDFUploadState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null)

  const isPdfMissing = report.pdf_file_missing
  const isReplacing = report.has_summary_pdf || isPdfMissing

  // Use external error message if provided, otherwise use local
  const displayError = errorMessage || localErrorMessage

  const handleUpload = async (file: File) => {
    setSelectedFile(file)
    setUploadState('uploading')
    setLocalErrorMessage(null)

    try {
      const formData = new FormData()
      formData.append('pdf_file', file)

      const response = await fetch(
        `/api/backend/api/v1/report-reconciliation/reports/${report.report_id}/pdf-upload`,
        {
          method: 'POST',
          body: formData,
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || '上传失败')
      }

      setUploadState('success')
      notify({
        type: 'success',
        title: '上传成功',
        message: isReplacing ? 'PDF 已更新' : 'PDF 已上传',
      })

      // Trigger refresh after a short delay
      setTimeout(() => {
        onUploadSuccess()
      }, 1000)
    } catch (error) {
      setUploadState('error')
      setLocalErrorMessage(error instanceof Error ? error.message : '上传失败')
      notify({
        type: 'error',
        title: '上传失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
      throw error // Re-throw for UploadZone to handle
    }
  }

  const handleRemoveFile = () => {
    setSelectedFile(null)
    setLocalErrorMessage(null)
    setUploadState('idle')
  }

  return (
    <div className='flex flex-col items-center justify-center py-12 px-4'>
      {/* Header Info */}
      <div className='mb-6 text-center'>
        <h3 className='text-lg font-semibold mb-1'>
          {isReplacing ? '更新 PDF 文件' : '上传 PDF 文件'}
        </h3>
        <p className='text-sm text-muted-foreground'>
          {isPdfMissing
            ? '原文件已丢失，请重新上传'
            : isReplacing
              ? '上传新文件将覆盖原有文件'
              : '请上传该月的结算汇总 PDF'}
        </p>
      </div>

      {/* Upload Zone */}
      <div className='w-full max-w-md'>
        <UploadZone
          accept=".pdf,application/pdf"
          maxSize={50}
          onUpload={handleUpload}
          uploadingText="上传中..."
          disabled={uploadState === 'uploading'}
          className="[&>div:first-child]:flex-col"
        />
      </div>

      {/* Selected File Info */}
      {selectedFile && uploadState === 'idle' && (
        <div className='mt-4 flex flex-col items-center gap-3'>
          <div className='flex h-14 w-14 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30'>
            <File className='h-7 w-7 text-emerald-600 dark:text-emerald-400' />
          </div>
          <div className='text-center'>
            <p className='text-sm font-medium truncate max-w-[280px]'>{selectedFile.name}</p>
            <p className='text-xs text-muted-foreground'>
              {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={handleRemoveFile}
          >
            移除
          </Button>
        </div>
      )}

      {/* Error Message */}
      {displayError && (
        <div className='mt-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400'>
          <XCircle className='h-4 w-4' />
          {displayError}
        </div>
      )}

      {/* Success State */}
      {uploadState === 'success' && (
        <div className='mt-6 flex flex-col items-center gap-2'>
          <div className='flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30'>
            <Check className='h-6 w-6 text-emerald-600 dark:text-emerald-400' />
          </div>
          <p className='text-sm font-medium text-emerald-600 dark:text-emerald-400'>上传成功</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className='mt-6 flex items-center gap-3'>
        {uploadState !== 'success' && (
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
        )}
        {uploadState === 'success' && (
          <Button variant='outline' onClick={onClose}>
            关闭
          </Button>
        )}
      </div>

      {/* Warning for replacement */}
      {isReplacing && !isPdfMissing && (
        <p className='mt-4 text-xs text-amber-600 dark:text-amber-400'>
          注意：上传新文件将覆盖原有的 PDF 文件
        </p>
      )}
    </div>
  )
}

// ─── Detail Panel Component ──────────────────────────────────────────────────

// Error types for reconciliation
type ReconcileErrorType = 'pdf_download_failed' | 'extraction_failed' | 'unknown' | null

function DetailPanel({
  report,
  result,
  reconciling,
  onClose,
  onUploadSuccess,
  onReconcile,
  errorType,
  onClearError,
  onShowUpload,
}: {
  report: AvailableReport
  result: ReconcileResult | null
  reconciling: boolean
  onClose: () => void
  onUploadSuccess: () => void
  onReconcile: (report: AvailableReport) => void
  errorType: ReconcileErrorType
  onClearError: () => void
  onShowUpload: () => void  // Callback to show upload panel
}) {
  const { notify } = useNotifications()
  const country = report.country

  // Determine if we should show upload panel or reconciliation result
  const hasPdf = report.has_summary_pdf && !report.pdf_file_missing
  const needsUpload = !report.has_summary_pdf || report.pdf_file_missing
  const needsCalculation = !report.pt3_calculation_complete

  // Show upload panel if: needs upload OR has PDF error OR explicitly requested
  const showUploadPanel = needsUpload || errorType !== null

  // Auto-trigger reconciliation when panel opens with canReconcile
  const [autoTriggered, setAutoTriggered] = useState(false)

  useEffect(() => {
    if (hasPdf && !result && !reconciling && !autoTriggered && errorType === null) {
      // Will be triggered by parent
      setAutoTriggered(true)
    }
  }, [hasPdf, result, reconciling, autoTriggered, errorType])

  // Clear error when switching to upload panel
  useEffect(() => {
    if (showUploadPanel && errorType !== null) {
      onClearError()
    }
  }, [showUploadPanel, errorType, onClearError])

  // Get error message for display
  const getErrorMessage = () => {
    switch (errorType) {
      case 'pdf_download_failed':
        return 'PDF 文件无法下载，可能已被删除或 R2 存储异常'
      case 'extraction_failed':
        return 'PDF 数据提取失败，请检查文件格式'
      default:
        return '核对过程中发生错误'
    }
  }

  return (
    <div className='fixed inset-y-0 right-0 z-50 w-full max-w-2xl border-l bg-background shadow-xl animate-in slide-in-from-right duration-300'>
      {/* Header */}
      <div className='flex items-center justify-between border-b px-6 py-4'>
        <div>
          <h2 className='text-lg font-semibold'>
            {formatMonth(report.report_month)} - {COUNTRY_LABELS[country] || country}
          </h2>
          <p className='text-sm text-muted-foreground'>{report.project_name}</p>
        </div>
        <Button variant='ghost' size='sm' onClick={onClose}>
          <X className='h-5 w-5' />
        </Button>
      </div>

      {/* Content */}
      <div className='h-[calc(100vh-80px)] overflow-y-auto p-6'>
        {/* Show upload panel if needs upload or file is missing or has error */}
        {showUploadPanel ? (
          <PDFUploadPanel
            report={report}
            onUploadSuccess={onUploadSuccess}
            onClose={onClose}
            errorMessage={errorType ? getErrorMessage() : undefined}
          />
        ) : needsCalculation ? (
          /* Show message if calculation not done */
          <div className='flex flex-col items-center justify-center py-20'>
            <AlertCircle className='h-10 w-10 text-amber-500' />
            <p className='mt-4 text-center font-medium'>报表核算未完成</p>
            <p className='mt-2 text-center text-sm text-muted-foreground'>
              请先在月报核算页面完成 PT3 报表核算，再进行核对
            </p>
            {/* Always show re-upload button */}
            <div className='mt-6 flex gap-3'>
              <Button variant='outline' onClick={() => onReconcile(report)}>
                <RefreshCw className='mr-2 h-4 w-4' />
                重新核对
              </Button>
              <Button variant='ghost' onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        ) : !result && reconciling ? (
          /* Loading state */
          <div className='flex flex-col items-center justify-center py-20'>
            <Loader2 className='h-10 w-10 animate-spin text-muted-foreground' />
            <p className='mt-4 text-muted-foreground'>正在核对...</p>
          </div>
        ) : result ? (
          /* Show reconciliation result */
          <>
            {/* Summary Stats */}
            <div className='mb-6 grid grid-cols-3 gap-4'>
              <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
                <div className='text-sm text-muted-foreground'>收入合计</div>
                <div className='mt-1 font-mono text-xl font-semibold'>
                  {formatCurrency(result.summary.db_total_income, country)}
                </div>
              </div>
              <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
                <div className='text-sm text-muted-foreground'>支出合计</div>
                <div className='mt-1 font-mono text-xl font-semibold'>
                  {formatCurrency(result.summary.db_total_expense, country)}
                </div>
              </div>
              <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
                <div className='text-sm text-muted-foreground'>净收款</div>
                <div className='mt-1 font-mono text-xl font-semibold text-emerald-600 dark:text-emerald-400'>
                  {formatCurrency(result.summary.db_net_amount, country)}
                </div>
              </div>
            </div>

            {/* Match Rate Badge */}
            <div className='mb-6 flex items-center gap-4'>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium',
                  result.match_rate === 100
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : result.match_rate >= 70
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                      : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                )}
              >
                {result.match_rate === 100 ? (
                  <CheckCircle2 className='h-4 w-4' />
                ) : result.match_rate >= 70 ? (
                  <AlertCircle className='h-4 w-4' />
                ) : (
                  <XCircle className='h-4 w-4' />
                )}
                匹配率 {result.match_rate}%
              </div>
              <span className='text-sm text-muted-foreground'>
                {result.matched_items}/{result.total_items} 匹配 · {result.mismatched_items} 差异 ·{' '}
                {result.missing_items} 缺失
              </span>
            </div>

            {/* Detail Table */}
            <div className='rounded-lg border overflow-hidden'>
              <table className='w-full border-collapse'>
                <thead>
                  <tr className='border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground'>
                    <th className='border-r px-4 py-3 text-left'>字段</th>
                    <th className='border-r px-4 py-3 text-right'>数据库</th>
                    <th className='border-r px-4 py-3 text-right'>PDF</th>
                    <th className='px-4 py-3 text-right'>差异</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item, index) => {
                    const label = FIELD_NAME_LABELS[item.field_name] || item.field_name
                    const isMatch = item.match
                    const rowBg = isMatch
                      ? 'bg-emerald-50/50 dark:bg-emerald-900/10'
                      : 'bg-red-50/50 dark:bg-red-900/10'

                    return (
                      <tr key={index} className={cn('border-b last:border-b-0', rowBg)}>
                        <td className='border-r px-4 py-3'>
                          <div className='flex items-center gap-2'>
                            {isMatch ? (
                              <CheckCircle2 className='h-4 w-4 shrink-0 text-emerald-500' />
                            ) : (
                              <XCircle className='h-4 w-4 shrink-0 text-red-500' />
                            )}
                            <span className='font-medium text-sm'>{label}</span>
                          </div>
                        </td>
                        <td
                          className={cn(
                            'border-r px-4 py-3 text-right font-mono',
                            isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'
                          )}
                        >
                          {formatCurrency(item.db_value, country)}
                        </td>
                        <td
                          className={cn(
                            'border-r px-4 py-3 text-right font-mono',
                            isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'
                          )}
                        >
                          {formatCurrency(item.pdf_value, country)}
                        </td>
                        <td className='px-4 py-3 text-right'>
                          {isMatch ? (
                            <span className='text-xs font-medium text-emerald-600 dark:text-emerald-400'>
                              OK
                            </span>
                          ) : (
                            <div className='flex flex-col items-end gap-0.5'>
                              <span className='text-xs font-medium text-red-600 dark:text-red-400'>
                                {formatCurrency(item.difference, country)}
                              </span>
                              {item.difference_percent !== null && (
                                <span className='text-xs text-muted-foreground'>
                                  ({item.difference_percent}%)
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Re-upload PDF Button - Always visible */}
            <div className='mt-6 flex justify-center gap-3'>
              <Button
                variant='outline'
                onClick={onShowUpload}
              >
                <Upload className='mr-2 h-4 w-4' />
                重新上传 PDF
              </Button>
            </div>
          </>
        ) : (
          /* Empty state - should not happen normally */
          <div className='flex flex-col items-center justify-center py-20'>
            <FileText className='h-10 w-10 text-muted-foreground/50' />
            <p className='mt-4 text-muted-foreground'>暂无数据</p>
            <div className='mt-6 flex gap-3'>
              <Button variant='outline' onClick={() => onReconcile(report)}>
                <RefreshCw className='mr-2 h-4 w-4' />
                重新核对
              </Button>
              <Button variant='ghost' onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AutoReconcileTab() {
  const { notify } = useNotifications()

  // Filter state
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState<string>('US')

  // Data state
  const [availableReports, setAvailableReports] = useState<AvailableReport[]>([])
  const [reconcileResults, setReconcileResults] = useState<Map<number, ReconcileResult>>(new Map())
  const [loading, setLoading] = useState(false)
  const [reconciling, setReconciling] = useState<number | null>(null)
  const [selectedReport, setSelectedReport] = useState<AvailableReport | null>(null)

  // Error state for reconciliation
  const [reconcileError, setReconcileError] = useState<{
    reportId: number
    errorType: ReconcileErrorType
  } | null>(null)

  // Track if we should show upload panel (for re-upload flow)
  const [showUploadPanel, setShowUploadPanel] = useState(false)

  // Derive current reconciliation result based on selected report
  // This ensures we always have the latest result data
  const currentResult = useMemo(() => {
    if (!selectedReport) return null
    return reconcileResults.get(selectedReport.report_id) ?? null
  }, [selectedReport, reconcileResults])

  // Get current error for selected report
  const currentError = useMemo(() => {
    if (!selectedReport) return null
    if (reconcileError?.reportId === selectedReport.report_id) {
      return reconcileError.errorType
    }
    return null
  }, [selectedReport, reconcileError])

  // Determine if we should show upload panel
  const shouldShowUploadPanel = useMemo(() => {
    if (!selectedReport) return false
    if (showUploadPanel) return true
    if (currentError) return true
    // Also show if PDF is missing or doesn't exist
    if (!selectedReport.has_summary_pdf || selectedReport.pdf_file_missing) return true
    return false
  }, [selectedReport, showUploadPanel, currentError])

  // Fetch available reports
  const fetchAvailableReports = useCallback(async () => {
    if (!projectId) {
      setAvailableReports([])
      return
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({
        project_id: projectId,
        ...(country ? { country } : {}),
      })

      const response = await fetch(`/api/backend/api/v1/report-reconciliation/available-reports?${params}`)
      if (!response.ok) throw new Error('Failed to fetch available reports')

      const data = await response.json()
      setAvailableReports(data.reports || [])
    } catch (error) {
      notify({
        type: 'error',
        title: '加载失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setLoading(false)
    }
  }, [projectId, country, notify])

  // Auto-fetch when filters change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchAvailableReports()
    }, 300)
    return () => clearTimeout(timer)
  }, [fetchAvailableReports])

  // Perform reconciliation when row is clicked
  // Always opens the panel, regardless of whether reconciliation can proceed
  const handleRowClick = async (report: AvailableReport) => {
    // Check if can reconcile
    const canReconcile = report.has_summary_pdf && report.pt3_calculation_complete

    // Clear any previous errors for this report
    if (reconcileError?.reportId === report.report_id) {
      setReconcileError(null)
    }

    // Close upload panel when opening detail
    setShowUploadPanel(false)

    // Always open the panel first
    setSelectedReport(report)

    // If can reconcile and not already reconciled, start reconciliation
    if (canReconcile && !reconcileResults.has(report.report_id)) {
      setReconciling(report.report_id)

      try {
        const response = await fetch('/api/backend/api/v1/report-reconciliation/auto-reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            report_id: report.report_id,
            tolerance: 0.01,
            country: report.country,
          }),
        })

        if (!response.ok) {
          const error = await response.json()
          const errorDetail = error.detail || '核对失败'

          // Determine error type based on message
          let errorType: ReconcileErrorType = 'unknown'
          if (errorDetail.includes('download') || errorDetail.includes('Failed to download')) {
            errorType = 'pdf_download_failed'
          } else if (errorDetail.includes('extract') || errorDetail.includes('PDF')) {
            errorType = 'extraction_failed'
          }

          // Set error state to show upload panel
          setReconcileError({ reportId: report.report_id, errorType })
          notify({
            type: 'warning',
            title: '核对失败',
            message: errorDetail,
          })
          return
        }

        const result: ReconcileResult = await response.json()

        // Update results
        setReconcileResults((prev) => {
          const newMap = new Map(prev)
          newMap.set(report.report_id, result)
          return newMap
        })

        // Clear any error state
        if (reconcileError?.reportId === report.report_id) {
          setReconcileError(null)
        }

        // Show notification
        if (result.match_rate === 100) {
          notify({ type: 'success', title: '核对完成', message: '所有数据项均匹配' })
        } else if (result.mismatched_items > 0) {
          notify({
            type: 'warning',
            title: '核对完成',
            message: `发现 ${result.mismatched_items} 项差异，请检查`,
          })
        } else {
          notify({ type: 'info', title: '核对完成', message: '核对成功' })
        }
      } catch (error) {
        // Determine error type
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        let errorType: ReconcileErrorType = 'unknown'
        if (errorMessage.includes('download') || errorMessage.includes('Failed to download')) {
          errorType = 'pdf_download_failed'
        } else if (errorMessage.includes('extract') || errorMessage.includes('PDF')) {
          errorType = 'extraction_failed'
        }

        // Set error state to show upload panel
        setReconcileError({ reportId: report.report_id, errorType })
        notify({
          type: 'warning',
          title: '核对失败',
          message: errorMessage,
        })
      } finally {
        setReconciling(null)
      }
    }
  }

  // Trigger reconcile (called from DetailPanel)
  const handleReconcile = useCallback(async (report: AvailableReport) => {
    // Close upload panel first
    setShowUploadPanel(false)

    // Clear error state
    if (reconcileError?.reportId === report.report_id) {
      setReconcileError(null)
    }

    // Clear cached result to force re-reconcile
    setReconcileResults((prev) => {
      const newMap = new Map(prev)
      newMap.delete(report.report_id)
      return newMap
    })

    // Trigger the row click to re-open panel and reconcile
    await handleRowClick(report)
  }, [reconcileError])

  // Handle upload success - refresh reports and trigger reconcile
  const handleUploadSuccess = useCallback(() => {
    if (!selectedReport) return

    // Close upload panel
    setShowUploadPanel(false)

    // Clear cached result
    setReconcileResults((prev) => {
      const newMap = new Map(prev)
      newMap.delete(selectedReport.report_id)
      return newMap
    })

    // Fetch updated reports first
    fetchAvailableReports().then(() => {
      // If PT3 calculation is complete, auto-trigger reconcile
      if (selectedReport.pt3_calculation_complete) {
        setReconciling(selectedReport.report_id)

        fetch('/api/backend/api/v1/report-reconciliation/auto-reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            report_id: selectedReport.report_id,
            tolerance: 0.01,
            country: selectedReport.country,
          }),
        })
          .then((response) => {
            if (!response.ok) {
              const error = response.json()
              return error.then((e: { detail?: string }) => {
                throw new Error(e.detail || '核对失败')
              })
            }
            return response.json()
          })
          .then((result: ReconcileResult) => {
            setReconcileResults((prev) => {
              const newMap = new Map(prev)
              newMap.set(selectedReport.report_id, result)
              return newMap
            })

            // Clear any error state
            if (reconcileError?.reportId === selectedReport.report_id) {
              setReconcileError(null)
            }

            // Show notification
            if (result.match_rate === 100) {
              notify({ type: 'success', title: '核对完成', message: '所有数据项均匹配' })
            } else if (result.mismatched_items > 0) {
              notify({
                type: 'warning',
                title: '核对完成',
                message: `发现 ${result.mismatched_items} 项差异，请检查`,
              })
            } else {
              notify({ type: 'info', title: '核对完成', message: '核对成功' })
            }
          })
          .catch((error) => {
            // Determine error type
            const errorMessage = error instanceof Error ? error.message : '核对失败'
            let errorType: ReconcileErrorType = 'unknown'
            if (errorMessage.includes('download') || errorMessage.includes('Failed to download')) {
              errorType = 'pdf_download_failed'
            } else if (errorMessage.includes('extract') || errorMessage.includes('PDF')) {
              errorType = 'extraction_failed'
            }

            setReconcileError({ reportId: selectedReport.report_id, errorType })
            notify({
              type: 'warning',
              title: '核对失败',
              message: errorMessage,
            })
          })
          .finally(() => {
            setReconciling(null)
          })
      }
    })
  }, [selectedReport, fetchAvailableReports, reconcileError, notify])

  // Handle panel close
  const handlePanelClose = useCallback(() => {
    setSelectedReport(null)
    setReconcileError(null)
    setShowUploadPanel(false)
  }, [])

  // Handle showing upload panel (from re-upload button)
  const handleShowUploadPanel = useCallback(() => {
    setShowUploadPanel(true)
    setReconcileError(null)
  }, [])

  // Handle clear error
  const handleClearError = useCallback(() => {
    if (selectedReport) {
      setReconcileError((prev) =>
        prev?.reportId === selectedReport.report_id ? null : prev
      )
    }
  }, [selectedReport])

  // Group reports
  const canReconcileReports = availableReports.filter(
    (r) => r.has_summary_pdf && r.pt3_calculation_complete
  )

  return (
    <div className='space-y-6'>
      {/* Console / Filter Bar */}
      <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
        <DataCardContent className='p-4'>
          <div className='flex flex-wrap items-end gap-4'>
            <div className='w-48'>
              <label className='mb-1 block text-xs font-medium text-muted-foreground'>项目</label>
              <ProjectSelect
                value={projectId}
                onChange={setProjectId}
                placeholder='选择项目'
                autoSelectFirst={false}
              />
            </div>
            <div className='w-36'>
              <label className='mb-1 block text-xs font-medium text-muted-foreground'>站点</label>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={fetchAvailableReports}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </DataCardContent>
      </DataCard>

      {/* Reports List */}
      {projectId && (
        <>
          <div className='flex items-center justify-between'>
            <h2 className='text-lg font-semibold'>可核对月报</h2>
            <span className='text-sm text-muted-foreground'>
              共 {availableReports.length} 条记录
              {canReconcileReports.length > 0 && (
                <span className='ml-2 text-emerald-600'>
                  ({canReconcileReports.length} 条可核对)
                </span>
              )}
            </span>
          </div>

          <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
            {availableReports.length > 0 ? (
              <div className='overflow-x-auto'>
                <table className='w-full border-collapse'>
                  <thead>
                    <tr className='border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground'>
                      <th className='px-4 py-3 text-left'>月份</th>
                      <th className='px-4 py-3 text-left'>站点</th>
                      <th className='px-4 py-3 text-center'>PDF</th>
                      <th className='px-4 py-3 text-center'>核算</th>
                      <th className='px-4 py-3 text-center'>核对</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availableReports.map((report) => {
                      const result = reconcileResults.get(report.report_id) ?? null
                      const isReconciling = reconciling === report.report_id
                      const status = getReconcileStatus(result, isReconciling, report.reconciled, report.reconcile_match_rate)
                      const canReconcile = report.has_summary_pdf && report.pt3_calculation_complete
                      const isSelected = selectedReport?.report_id === report.report_id

                      return (
                        <tr
                          key={report.report_id}
                          className={cn(
                            'cursor-pointer border-b transition-colors',
                            isSelected
                              ? 'bg-primary/5'
                              : 'hover:bg-[hsl(var(--surface-subtle))'
                          )}
                          onClick={() => handleRowClick(report)}
                        >
                          <td className='px-4 py-3'>
                            <span className='font-medium'>{formatMonth(report.report_month)}</span>
                          </td>
                          <td className='px-4 py-3 text-sm'>
                            {COUNTRY_LABELS[report.country] || report.country}
                          </td>
                          <td className='px-4 py-3'>
                            <div className='flex justify-center' title={report.pdf_file_missing ? 'PDF 文件缺失' : ''}>
                              {report.pdf_file_missing ? (
                                <FileX className='h-5 w-5 text-red-400' />
                              ) : report.has_summary_pdf ? (
                                <CheckCircle2 className='h-5 w-5 text-emerald-500' />
                              ) : (
                                <XCircle className='h-5 w-5 text-red-500' />
                              )}
                            </div>
                          </td>
                          <td className='px-4 py-3'>
                            <div className='flex justify-center'>
                              {report.pt3_calculation_complete ? (
                                <CheckCircle2 className='h-5 w-5 text-emerald-500' />
                              ) : (
                                <XCircle className='h-5 w-5 text-red-500' />
                              )}
                            </div>
                          </td>
                          <td className='px-4 py-3'>
                            <div className='flex justify-center'>
                              {/* If can reconcile OR was previously reconciled, show status */}
                              {(canReconcile || report.reconciled) ? (
                                <ReconcileStatusIcon status={status} />
                              ) : (
                                <Minus className='h-5 w-5 text-muted-foreground/40' />
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <DataCardContent className='p-8 text-center text-muted-foreground'>
                <FileText className='mx-auto h-12 w-12 opacity-50' />
                <p className='mt-4'>暂无月报数据</p>
              </DataCardContent>
            )}
          </DataCard>

          {/* Legend */}
          <div className='flex flex-wrap items-center gap-6 text-sm text-muted-foreground'>
            <span className='flex items-center gap-2'>
              <Minus className='h-4 w-4 text-muted-foreground/40' />
              待核对
            </span>
            <span className='flex items-center gap-2'>
              <CheckCircle2 className='h-4 w-4 text-emerald-500' />
              100% 匹配
            </span>
            <span className='flex items-center gap-2'>
              <AlertCircle className='h-4 w-4 text-amber-500' />
              70-99% 匹配
            </span>
            <span className='flex items-center gap-2'>
              <XCircle className='h-4 w-4 text-red-500' />
              &lt;70% 匹配
            </span>
          </div>
        </>
      )}

      {/* Empty state before project selection */}
      {!projectId && (
        <div className='rounded-lg border border-dashed p-8 text-center'>
          <FileText className='mx-auto h-12 w-12 text-muted-foreground/50' />
          <p className='mt-4 text-muted-foreground'>请先选择项目和站点</p>
        </div>
      )}

      {/* Detail Panel */}
      {selectedReport && (
        <>
          {/* Backdrop */}
          <div
            className='fixed inset-0 z-40 bg-black/20'
            onClick={handlePanelClose}
          />

          {/* Panel */}
          <DetailPanel
            report={selectedReport}
            result={currentResult}
            reconciling={reconciling === selectedReport.report_id}
            onClose={handlePanelClose}
            onUploadSuccess={handleUploadSuccess}
            onReconcile={handleReconcile}
            errorType={currentError}
            onClearError={handleClearError}
            onShowUpload={handleShowUploadPanel}
          />
        </>
      )}
    </div>
  )
}

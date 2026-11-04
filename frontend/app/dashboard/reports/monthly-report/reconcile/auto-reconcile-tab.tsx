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
  FileX,
  Upload,
  FileUp,
  File,
  Check,
  Table,
  Download,
} from 'lucide-react'

import { WarmButton, WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import styles from './reconcile-warm.module.css'

interface AutoReconcileTabProps {
  projectId: string
  setProjectId: (v: string) => void
  country: string
  setCountry: (v: string) => void
  loading: boolean
  setLoading: (v: boolean) => void
  fetchAvailableReportsRef: React.MutableRefObject<() => void>
}

// ─── Types ───────────────────────────────────────────────────────────────────

type AvailableReport = {
  report_id: number
  project_name: string
  country: string
  report_month: string
  has_summary_pdf: boolean
  pdf_url: string | null // R2 URL for direct access
  pdf_uploaded_at: string | null
  pt3_calculation_complete: boolean
  pt4_calculation_complete: boolean
  status: string
  pdf_file_missing?: boolean
  has_transaction_csv?: boolean
  transaction_csv_missing?: boolean
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
      return <Minus className={styles.iconMuted} />
    case 'reconciling':
      return <Loader2 className={cn(styles.iconLoading, styles.spin)} />
    case 'success':
      return <CheckCircle2 className={styles.iconPositive} />
    case 'warning':
      return <AlertCircle className={styles.iconWarning} />
    case 'error':
      return <XCircle className={styles.iconNegative} />
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
  errorMessage?: string // NEW: external error to display
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
    <div className={styles.uploadPanel}>
      {/* Header Info */}
      <div className={styles.uploadHeader}>
        <h3>
          {isReplacing ? '更新 PDF 文件' : '上传 PDF 文件'}
        </h3>
        <p>
          {isPdfMissing
            ? '原文件已丢失，请重新上传'
            : isReplacing
              ? '上传新文件将覆盖原有文件'
              : '请上传该月的结算汇总 PDF'}
        </p>
      </div>

      {/* Upload Zone */}
      <div className={styles.uploadZoneWrap}>
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
        <div className={styles.selectedFile}>
          <div className={styles.fileBadge}>
            <File className={styles.fileIcon} />
          </div>
          <div className={styles.selectedFileCopy}>
            <p className={styles.fileName}>{selectedFile.name}</p>
            <p className={styles.fileMeta}>
              {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          <WarmButton variant="secondary" className={styles.compactButton} onClick={handleRemoveFile}>
            移除
          </WarmButton>
        </div>
      )}

      {/* Error Message */}
      {displayError && (
        <div className={styles.errorRow}>
          <XCircle className={styles.inlineIcon} />
          {displayError}
        </div>
      )}

      {/* Success State */}
      {uploadState === 'success' && (
        <div className={styles.uploadSuccess}>
          <div className={styles.successBadge}>
            <Check className={styles.successIcon} />
          </div>
          <p>上传成功</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className={styles.actionRow}>
        {uploadState !== 'success' && (
          <WarmButton variant="secondary" onClick={onClose}>
            取消
          </WarmButton>
        )}
        {uploadState === 'success' && (
          <WarmButton variant="secondary" onClick={onClose}>
            关闭
          </WarmButton>
        )}
      </div>

      {/* Warning for replacement */}
      {isReplacing && !isPdfMissing && (
        <p className={styles.warningText}>
          注意：上传新文件将覆盖原有的 PDF 文件
        </p>
      )}
    </div>
  )
}

async function handleDownloadCSV(
  reportId: number,
  notify: ReturnType<typeof useNotifications>['notify']
) {
  try {
    const response = await fetch(
      `/api/backend/api/v1/report-reconciliation/reports/${reportId}/download-csv`
    )
    if (!response.ok) throw new Error('下载失败')
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    const filename = utf8Match?.[1] ? decodeURIComponent(utf8Match[1]) : 'transaction.csv'
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  } catch (error) {
    notify({
      type: 'error',
      title: '下载失败',
      message: error instanceof Error ? error.message : '未知错误',
    })
  }
}

// ─── CSV Upload Panel Component (settlement transaction CSV re-upload) ────────

function CSVUploadPanel({
  report,
  onUploadSuccess,
  onClose,
  errorMessage,
}: {
  report: AvailableReport
  onUploadSuccess: () => void
  onClose: () => void
  errorMessage?: string
}) {
  const { notify } = useNotifications()
  const [uploadState, setUploadState] = useState<PDFUploadState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null)

  const isCsvMissing = report.transaction_csv_missing
  const isReplacing = report.has_transaction_csv || isCsvMissing

  const displayError = errorMessage || localErrorMessage

  const handleUpload = async (file: File) => {
    setSelectedFile(file)
    setUploadState('uploading')
    setLocalErrorMessage(null)
    try {
      const formData = new FormData()
      formData.append('csv_file', file)
      const response = await fetch(
        `/api/backend/api/v1/report-reconciliation/reports/${report.report_id}/csv-upload`,
        { method: 'POST', body: formData }
      )
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || '上传失败')
      }
      setUploadState('success')
      notify({
        type: 'success',
        title: '上传成功',
        message: isReplacing ? 'CSV 已更新' : 'CSV 已上传',
      })
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
      throw error
    }
  }

  const handleRemoveFile = () => {
    setSelectedFile(null)
    setLocalErrorMessage(null)
    setUploadState('idle')
  }

  return (
    <div className={styles.uploadPanel}>
      <div className={styles.uploadHeader}>
        <h3>
          {isReplacing ? '更新 CSV 文件' : '上传 CSV 文件'}
        </h3>
        <p>
          {isCsvMissing
            ? '原文件已丢失，请重新上传'
            : isReplacing
              ? '上传新文件将覆盖原有 CSV'
              : '请上传该月的结算交易 CSV'}
        </p>
      </div>

      <div className={styles.uploadZoneWrap}>
        <UploadZone
          accept=".csv,text/csv"
          maxSize={50}
          onUpload={handleUpload}
          uploadingText="上传中..."
          disabled={uploadState === 'uploading'}
          className="[&>div:first-child]:flex-col"
        />
      </div>

      {selectedFile && uploadState === 'idle' && (
        <div className={styles.selectedFile}>
          <div className={styles.fileBadge}>
            <File className={styles.fileIcon} />
          </div>
          <div className={styles.selectedFileCopy}>
            <p className={styles.fileName}>{selectedFile.name}</p>
            <p className={styles.fileMeta}>
              {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          <WarmButton variant="secondary" className={styles.compactButton} onClick={handleRemoveFile}>
            移除
          </WarmButton>
        </div>
      )}

      {displayError && (
        <div className={styles.errorRow}>
          <XCircle className={styles.inlineIcon} />
          {displayError}
        </div>
      )}

      {uploadState === 'success' && (
        <div className={styles.uploadSuccess}>
          <div className={styles.successBadge}>
            <Check className={styles.successIcon} />
          </div>
          <p>上传成功</p>
        </div>
      )}

      <div className={styles.actionRow}>
        {uploadState !== 'success' && (
          <WarmButton variant="secondary" onClick={onClose}>
            取消
          </WarmButton>
        )}
        {uploadState === 'success' && (
          <WarmButton variant="secondary" onClick={onClose}>
            关闭
          </WarmButton>
        )}
      </div>

      {isReplacing && !isCsvMissing && (
        <p className={styles.warningText}>
          注意：上传新文件将覆盖原有的 CSV 文件
        </p>
      )}
    </div>
  )
}

// ─── Raw Files Group (always-visible source-file access) ────────────────────

function RawFilesGroup({
  report,
  onShowUpload,
  onUploadSuccess,
}: {
  report: AvailableReport
  onShowUpload: (target: 'pdf' | 'csv') => void
  onUploadSuccess: () => void
}) {
  const { notify } = useNotifications()

  const pdfAvailable = report.has_summary_pdf && !report.pdf_file_missing
  const csvAvailable = report.has_transaction_csv && !report.transaction_csv_missing

  return (
    <section className={styles.rawFiles} aria-label="原始文件 / 数据">
      <div className={styles.rawFilesHeader}>
        <span>原始文件 / 数据</span>
      </div>
      <div className={styles.rawFilesList}>
        {/* PT3 Excel Download */}
        <button
          type="button"
          className={styles.rawFileRow}
          onClick={() => handleDownloadPT3Excel(report.report_id, notify)}
        >
          <Table className={cn(styles.rawFileIcon, styles.iconPositive)} />
          <div className={styles.rawFileCopy}>
            <div>数据库数据</div>
            <span>PT3 核算数据 (.xlsx)</span>
          </div>
          <Download className={styles.rawFileDownload} />
        </button>

        {/* PDF Download */}
        {pdfAvailable ? (
          <button
            type="button"
            className={styles.rawFileRow}
            onClick={() => handleDownloadPDF(report.report_id, notify)}
          >
            <FileText className={cn(styles.rawFileIcon, styles.iconAccent)} />
            <div className={styles.rawFileCopy}>
              <div>PDF 原文</div>
              <span>结算汇总 PDF</span>
            </div>
            <Download className={styles.rawFileDownload} />
          </button>
        ) : (
          <div className={cn(styles.rawFileRow, styles.rawFileDisabled)}>
            <FileText className={cn(styles.rawFileIcon, styles.iconMuted)} />
            <div className={styles.rawFileCopy}>
              <div>PDF 原文</div>
              <span>PDF 文件不可用</span>
            </div>
          </div>
        )}

        {/* CSV Download */}
        {csvAvailable ? (
          <button
            type="button"
            className={styles.rawFileRow}
            onClick={() => handleDownloadCSV(report.report_id, notify)}
          >
            <Table className={cn(styles.rawFileIcon, styles.iconWarning)} />
            <div className={styles.rawFileCopy}>
              <div>源 CSV</div>
              <span>结算交易 CSV</span>
            </div>
            <Download className={styles.rawFileDownload} />
          </button>
        ) : (
          <div className={cn(styles.rawFileRow, styles.rawFileDisabled)}>
            <Table className={cn(styles.rawFileIcon, styles.iconMuted)} />
            <div className={styles.rawFileCopy}>
              <div>源 CSV</div>
              <span>
                {report.transaction_csv_missing ? '源文件已丢失' : '暂无源文件'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Re-upload buttons */}
      <div className={styles.rawFilesActions}>
        <WarmButton variant="secondary" onClick={() => onShowUpload('pdf')}>
          <Upload className="mr-2 h-4 w-4" />
          重新上传 PDF
        </WarmButton>
        <WarmButton variant="secondary" onClick={() => onShowUpload('csv')}>
          <FileUp className="mr-2 h-4 w-4" />
          重新上传 CSV
        </WarmButton>
      </div>

      {/* Paste / drag / click upload area (common UploadZone design) */}
      <div className={styles.rawUploadZone}>
        <p>
          粘贴 / 拖拽 / 选择文件上传（支持 PDF 与 CSV）
        </p>
        <UploadZone
          accept=".pdf,.csv,application/pdf,text/csv"
          maxSize={50}
          uploadingText="上传中..."
          showPreview={false}
          onUpload={async (file: File) => {
            const isPdf =
              file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
            const endpoint = isPdf ? 'pdf-upload' : 'csv-upload'
            const field = isPdf ? 'pdf_file' : 'csv_file'
            const formData = new FormData()
            formData.append(field, file)
            try {
              const res = await fetch(
                `/api/backend/api/v1/report-reconciliation/reports/${report.report_id}/${endpoint}`,
                { method: 'POST', body: formData }
              )
              if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error((err as { detail?: string }).detail || '上传失败')
              }
              notify({
                type: 'success',
                title: '上传成功',
                message: isPdf ? 'PDF 已更新' : 'CSV 已更新',
              })
              setTimeout(() => onUploadSuccess(), 1000)
            } catch (e) {
              notify({
                type: 'error',
                title: '上传失败',
                message: e instanceof Error ? e.message : '未知错误',
              })
            }
          }}
        />
      </div>
    </section>
  )
}

// ─── Detail Panel Component ──────────────────────────────────────────────────

// Error types for reconciliation
type ReconcileErrorType = 'pdf_download_failed' | 'extraction_failed' | 'unknown' | null

async function handleDownloadPT3Excel(
  reportId: number,
  notify: ReturnType<typeof useNotifications>['notify']
) {
  try {
    const response = await fetch(
      `/api/backend/api/v1/report-reconciliation/reports/${reportId}/export-pt3`
    )
    if (!response.ok) {
      throw new Error('下载失败')
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    const filename = utf8Match?.[1] ? decodeURIComponent(utf8Match[1]) : 'pt3-data.xlsx'
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  } catch (error) {
    notify({
      type: 'error',
      title: '下载失败',
      message: error instanceof Error ? error.message : '未知错误',
    })
  }
}

async function handleDownloadPDF(
  reportId: number,
  notify: ReturnType<typeof useNotifications>['notify']
) {
  try {
    const response = await fetch(
      `/api/backend/api/v1/report-reconciliation/reports/${reportId}/download-pdf`
    )
    if (!response.ok) throw new Error('下载失败')
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    const filename = utf8Match?.[1] ? decodeURIComponent(utf8Match[1]) : 'summary.pdf'
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  } catch (error) {
    notify({
      type: 'error',
      title: '下载失败',
      message: error instanceof Error ? error.message : '未知错误',
    })
  }
}

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
  uploadTarget,
}: {
  report: AvailableReport
  result: ReconcileResult | null
  reconciling: boolean
  onClose: () => void
  onUploadSuccess: () => void
  onReconcile: (report: AvailableReport) => void
  errorType: ReconcileErrorType
  onClearError: () => void
  onShowUpload: (target: 'pdf' | 'csv') => void
  uploadTarget: 'pdf' | 'csv' | null
}) {
  const { notify } = useNotifications()
  const country = report.country

  // Determine if we should show upload panel or reconciliation result
  const hasPdf = report.has_summary_pdf && !report.pdf_file_missing
  const needsUpload = !report.has_summary_pdf || report.pdf_file_missing
  const needsCalculation = !report.pt3_calculation_complete

  // Show upload panel if: needs upload OR has PDF error OR explicitly requested (uploadTarget)
  const uploadTargetResolved: 'pdf' | 'csv' | null =
    uploadTarget ?? (needsUpload || errorType !== null ? 'pdf' : null)
  const showUploadPanel = uploadTargetResolved !== null

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className={styles.dialog} data-warm-auto-reconcile-dialog="true">
        <DialogHeader className={styles.dialogHeader}>
          <DialogTitle>
            {formatMonth(report.report_month)} - {COUNTRY_LABELS[country] || country}
          </DialogTitle>
          <p className={styles.dialogSubtitle}>{report.project_name}</p>
        </DialogHeader>

        {/* Content */}
        <div className={styles.dialogBody}>
          {/* Show upload panel if needs upload or file is missing or has error */}
          {showUploadPanel ? (
            uploadTargetResolved === 'csv' ? (
              <CSVUploadPanel
                report={report}
                onUploadSuccess={onUploadSuccess}
                onClose={onClose}
                errorMessage={errorType ? getErrorMessage() : undefined}
              />
            ) : (
              <PDFUploadPanel
                report={report}
                onUploadSuccess={onUploadSuccess}
                onClose={onClose}
                errorMessage={errorType ? getErrorMessage() : undefined}
              />
            )
          ) : needsCalculation ? (
            /* Show message if calculation not done */
            <div className={styles.dialogState}>
              <AlertCircle className={styles.stateIconWarning} />
              <p className={styles.stateTitle}>报表核算未完成</p>
              <p className={styles.stateDescription}>
                请先在月报核算页面完成 PT3 报表核算，再进行核对
              </p>
              {/* Always show re-upload button */}
              <div className={styles.actionRow}>
                <WarmButton variant="secondary" onClick={() => onReconcile(report)}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  重新核对
                </WarmButton>
                <WarmButton variant="quiet" onClick={onClose}>
                  关闭
                </WarmButton>
              </div>
            </div>
          ) : !result && reconciling ? (
            /* Loading state */
            <div className={styles.dialogState} role="status">
              <Loader2 className={cn(styles.stateIcon, styles.spin)} />
              <p className={styles.stateDescription}>正在核对...</p>
            </div>
          ) : result ? (
            /* Show reconciliation result */
            <>
              {/* Summary Stats */}
              <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>收入合计</div>
                  <div className={styles.summaryValue}>
                    {formatCurrency(result.summary.db_total_income, country)}
                  </div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>支出合计</div>
                  <div className={styles.summaryValue}>
                    {formatCurrency(result.summary.db_total_expense, country)}
                  </div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>净收款</div>
                  <div className={cn(styles.summaryValue, styles.positiveText)}>
                    {formatCurrency(result.summary.db_net_amount, country)}
                  </div>
                </div>
              </div>

              {/* Match Rate Badge */}
              <div className={styles.matchSummary}>
                <WarmBadge
                  tone={
                    result.match_rate === 100
                      ? 'positive'
                      : result.match_rate >= 70
                        ? 'accent'
                        : 'negative'
                  }
                  className={styles.matchBadge}
                >
                  {result.match_rate === 100 ? (
                    <CheckCircle2 className={styles.inlineIcon} />
                  ) : result.match_rate >= 70 ? (
                    <AlertCircle className={styles.inlineIcon} />
                  ) : (
                    <XCircle className={styles.inlineIcon} />
                  )}
                  匹配率 {result.match_rate}%
                </WarmBadge>
                <span className={styles.matchMeta}>
                  {result.matched_items}/{result.total_items} 匹配 · {result.mismatched_items} 差异
                  · {result.missing_items} 缺失
                </span>
              </div>

              {/* Detail Table */}
              <div className={styles.tableScroll} data-warm-table-scroll="true">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th className={styles.numericCell}>数据库</th>
                      <th className={styles.numericCell}>PDF</th>
                      <th className={styles.numericCell}>差异</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((item, index) => {
                      const label = FIELD_NAME_LABELS[item.field_name] || item.field_name
                      const isMatch = item.match

                      return (
                        <tr key={index} data-match={isMatch ? 'true' : 'false'}>
                          <td>
                            <div className={styles.tableLabel}>
                              {isMatch ? (
                                <CheckCircle2 className={cn(styles.inlineIcon, styles.iconPositive)} />
                              ) : (
                                <XCircle className={cn(styles.inlineIcon, styles.iconNegative)} />
                              )}
                              <span>{label}</span>
                            </div>
                          </td>
                          <td
                            className={cn(styles.numericCell, !isMatch && styles.negativeText)}
                          >
                            {formatCurrency(item.db_value, country)}
                          </td>
                          <td
                            className={cn(styles.numericCell, !isMatch && styles.negativeText)}
                          >
                            {formatCurrency(item.pdf_value, country)}
                          </td>
                          <td className={styles.numericCell}>
                            {isMatch ? (
                              <span className={styles.positiveText}>
                                OK
                              </span>
                            ) : (
                              <div className={styles.difference}>
                                <span className={styles.negativeText}>
                                  {formatCurrency(item.difference, country)}
                                </span>
                                {item.difference_percent !== null && (
                                  <span className={styles.mutedText}>
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
            </>
          ) : (
            /* Empty state - should not happen normally */
            <div className={styles.dialogState}>
              <FileText className={styles.stateIcon} />
              <p className={styles.stateDescription}>暂无数据</p>
              <div className={styles.actionRow}>
                <WarmButton variant="secondary" onClick={() => onReconcile(report)}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  重新核对
                </WarmButton>
                <WarmButton variant="quiet" onClick={onClose}>
                  关闭
                </WarmButton>
              </div>
            </div>
          )}

          {!showUploadPanel && <RawFilesGroup report={report} onShowUpload={onShowUpload} onUploadSuccess={onUploadSuccess} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AutoReconcileTab({
  projectId,
  setProjectId,
  country,
  setCountry,
  loading,
  setLoading,
  fetchAvailableReportsRef,
}: AutoReconcileTabProps) {
  const { notify } = useNotifications()

  // Data state
  const [availableReports, setAvailableReports] = useState<AvailableReport[]>([])
  const [reconcileResults, setReconcileResults] = useState<Map<number, ReconcileResult>>(new Map())
  const [reconciling, setReconciling] = useState<number | null>(null)
  const [selectedReport, setSelectedReport] = useState<AvailableReport | null>(null)

  // Error state for reconciliation
  const [reconcileError, setReconcileError] = useState<{
    reportId: number
    errorType: ReconcileErrorType
  } | null>(null)

  // Track if we should show upload panel (for re-upload flow)
  const [uploadTarget, setUploadTarget] = useState<'pdf' | 'csv' | null>(null)

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

      const response = await fetch(
        `/api/backend/api/v1/report-reconciliation/available-reports?${params}`
      )
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
  }, [projectId, country, notify, setLoading])

  // Register fetch function to ref for header refresh
  useEffect(() => {
    fetchAvailableReportsRef.current = fetchAvailableReports
  }, [fetchAvailableReports, fetchAvailableReportsRef])

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
    setUploadTarget(null)

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
  const handleReconcile = useCallback(
    async (report: AvailableReport) => {
      // Close upload panel first
      setUploadTarget(null)

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
    },
    [reconcileError]
  )

  // Handle upload success - refresh reports and trigger reconcile
  const handleUploadSuccess = useCallback(() => {
    if (!selectedReport) return

    // Close upload panel
    setUploadTarget(null)

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
    setUploadTarget(null)
  }, [])

  // Handle showing upload panel for a given target (pdf / csv re-upload)
  const handleShowUpload = useCallback((target: 'pdf' | 'csv') => {
    setUploadTarget(target)
    setReconcileError(null)
  }, [])

  // Row-level fallback: download settlement CSV directly (no dialog needed)
  const handleRowDownloadCSV = useCallback(
    (report: AvailableReport) => {
      handleDownloadCSV(report.report_id, notify)
    },
    [notify]
  )

  // Handle clear error
  const handleClearError = useCallback(() => {
    if (selectedReport) {
      setReconcileError((prev) => (prev?.reportId === selectedReport.report_id ? null : prev))
    }
  }, [selectedReport])

  // Group reports
  const canReconcileReports = availableReports.filter(
    (r) => r.has_summary_pdf && r.pt3_calculation_complete
  )

  return (
    <div className={styles.stack} data-warm-auto-reconcile="true">
      {/* Reports List */}
      {projectId && (
        <>
          <div className={styles.sectionHeader}>
            <h2>可核对月报</h2>
            <span>
              共 {availableReports.length} 条记录
              {canReconcileReports.length > 0 && (
                <span className={styles.positiveText}>
                  ({canReconcileReports.length} 条可核对)
                </span>
              )}
            </span>
          </div>

          <section className={styles.panel} aria-label="可核对月报">
            {availableReports.length > 0 ? (
              <div className={styles.tableScroll} data-warm-table-scroll="true">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>月份</th>
                      <th>站点</th>
                      <th className={styles.centeredCell}>PDF</th>
                      <th className={styles.centeredCell}>核算</th>
                      <th className={styles.centeredCell}>核对</th>
                      <th className={styles.centeredCell}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availableReports.map((report) => {
                      const result = reconcileResults.get(report.report_id) ?? null
                      const isReconciling = reconciling === report.report_id
                      const status = getReconcileStatus(
                        result,
                        isReconciling,
                        report.reconciled,
                        report.reconcile_match_rate
                      )
                      const canReconcile = report.has_summary_pdf && report.pt3_calculation_complete
                      const isSelected = selectedReport?.report_id === report.report_id

                      return (
                        <tr
                          key={report.report_id}
                          className={styles.reportRow}
                          data-selected={isSelected ? 'true' : 'false'}
                          onClick={() => handleRowClick(report)}
                        >
                          <td>
                            <span>{formatMonth(report.report_month)}</span>
                          </td>
                          <td>
                            {COUNTRY_LABELS[report.country] || report.country}
                          </td>
                          <td className={styles.centeredCell}>
                            <div
                              className={styles.centeredContent}
                              title={report.pdf_file_missing ? 'PDF 文件缺失' : ''}
                            >
                              {report.pdf_file_missing ? (
                                <FileX className={styles.iconNegative} />
                              ) : report.has_summary_pdf ? (
                                <CheckCircle2 className={styles.iconPositive} />
                              ) : (
                                <XCircle className={styles.iconNegative} />
                              )}
                            </div>
                          </td>
                          <td className={styles.centeredCell}>
                            <div className={styles.centeredContent}>
                              {report.pt3_calculation_complete ? (
                                <CheckCircle2 className={styles.iconPositive} />
                              ) : (
                                <XCircle className={styles.iconNegative} />
                              )}
                            </div>
                          </td>
                          <td className={styles.centeredCell}>
                            <div className={styles.centeredContent}>
                              {/* If can reconcile OR was previously reconciled, show status */}
                              {canReconcile || report.reconciled ? (
                                <ReconcileStatusIcon status={status} />
                              ) : (
                                <Minus className={styles.iconMuted} />
                              )}
                            </div>
                          </td>
                          <td className={styles.centeredCell}>
                            <div className={styles.rowActions}>
                              <WarmButton
                                variant="quiet"
                                className={styles.rowAction}
                                title="下载源 CSV"
                                disabled={
                                  !report.has_transaction_csv || !!report.transaction_csv_missing
                                }
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRowDownloadCSV(report)
                                }}
                              >
                                <Table className="mr-1 h-4 w-4" />
                                CSV
                              </WarmButton>
                              <WarmButton
                                variant="quiet"
                                className={styles.rowAction}
                                title="下载 PDF"
                                disabled={!report.has_summary_pdf || !!report.pdf_file_missing}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDownloadPDF(report.report_id, notify)
                                }}
                              >
                                <FileText className="mr-1 h-4 w-4" />
                                PDF
                              </WarmButton>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.emptyState}>
                <FileText className={styles.emptyIcon} />
                <p>暂无月报数据</p>
              </div>
            )}
          </section>

          {/* Legend */}
          <div className={styles.legend}>
            <span>
              <Minus className={cn(styles.inlineIcon, styles.iconMuted)} />
              待核对
            </span>
            <span>
              <CheckCircle2 className={cn(styles.inlineIcon, styles.iconPositive)} />
              100% 匹配
            </span>
            <span>
              <AlertCircle className={cn(styles.inlineIcon, styles.iconWarning)} />
              70-99% 匹配
            </span>
            <span>
              <XCircle className={cn(styles.inlineIcon, styles.iconNegative)} />
              &lt;70% 匹配
            </span>
          </div>
        </>
      )}

      {/* Empty state before project selection */}
      {!projectId && (
        <div className={styles.emptyState}>
          <FileText className={styles.emptyIcon} />
          <p>请先选择项目和站点</p>
        </div>
      )}

      {/* Detail Panel */}
      {selectedReport && (
        <DetailPanel
          report={selectedReport}
          result={currentResult}
          reconciling={reconciling === selectedReport.report_id}
          onClose={handlePanelClose}
          onUploadSuccess={handleUploadSuccess}
          onReconcile={handleReconcile}
          errorType={currentError}
          onClearError={handleClearError}
          onShowUpload={handleShowUpload}
          uploadTarget={uploadTarget}
        />
      )}
    </div>
  )
}

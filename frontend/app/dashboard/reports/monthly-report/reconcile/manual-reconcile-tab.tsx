'use client'

import { useState } from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, FileText, FileUp } from 'lucide-react'

import { WarmBadge, WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import styles from './reconcile-warm.module.css'

type ReconciliationItem = {
  field_name: string
  excel_value: number | null
  pdf_value: number | null
  match: boolean
  difference: number | null
  difference_percent: number | null
}

type ReconciliationResult = {
  summary: {
    excel_total_income: number | null
    excel_total_expense: number | null
    excel_net_amount: number | null
    pdf_total_income: number | null
    pdf_total_expense: number | null
    pdf_net_amount: number | null
  }
  total_items: number
  matched_items: number
  mismatched_items: number
  missing_items: number
  match_rate: number
  items: ReconciliationItem[]
}

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

function formatCurrency(value: number | null | undefined, country: string = 'US'): string {
  if (value === null || value === undefined) return '-'
  const CURRENCY_BY_COUNTRY: Record<string, string> = {
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
  const currency = CURRENCY_BY_COUNTRY[country] ?? 'USD'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
}

function ResultItem({ item }: { item: ReconciliationItem }) {
  const label = FIELD_NAME_LABELS[item.field_name] || item.field_name
  const isMatch = item.match

  return (
    <tr data-match={isMatch ? 'true' : 'false'}>
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
      <td className={cn(styles.numericCell, !isMatch && styles.negativeText)}>
        {formatCurrency(item.excel_value)}
      </td>
      <td className={cn(styles.numericCell, !isMatch && styles.negativeText)}>
        {formatCurrency(item.pdf_value)}
      </td>
      <td className={styles.numericCell}>
        {isMatch ? (
          <span className={styles.positiveText}>OK</span>
        ) : (
          <span className={styles.negativeText}>
            差异: {formatCurrency(item.difference)}
            {item.difference_percent !== null && (
              <span className={styles.mutedText}>({item.difference_percent}%)</span>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}

function SummaryCard({ result }: { result: ReconciliationResult }) {
  const { summary } = result

  return (
    <div className={styles.summaryGrid}>
      <div className={styles.summaryCard}>
        <div className={styles.summaryLabel}>收入合计</div>
        <div className={styles.summaryValue}>
          {formatCurrency(summary.excel_total_income)}
        </div>
        <div className={styles.summaryMeta}>
          PDF: {formatCurrency(summary.pdf_total_income)}
        </div>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryLabel}>支出合计</div>
        <div className={styles.summaryValue}>
          {formatCurrency(summary.excel_total_expense)}
        </div>
        <div className={styles.summaryMeta}>
          PDF: {formatCurrency(summary.pdf_total_expense)}
        </div>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryLabel}>净收款</div>
        <div className={cn(styles.summaryValue, styles.positiveText)}>
          {formatCurrency(summary.excel_net_amount)}
        </div>
        <div className={styles.summaryMeta}>
          PDF: {formatCurrency(summary.pdf_net_amount)}
        </div>
      </div>
    </div>
  )
}

export default function ManualReconcileTab() {
  const { notify } = useNotifications()
  const [excelFile, setExcelFile] = useState<File | null>(null)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState<ReconciliationResult | null>(null)

  const handleFileChange =
    (type: 'excel' | 'pdf') => (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      if (type === 'excel') {
        if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
          notify({ type: 'error', title: '请上传 Excel 文件 (.xlsx, .xls)' })
          return
        }
        setExcelFile(file)
      } else {
        if (!file.name.endsWith('.pdf')) {
          notify({ type: 'error', title: '请上传 PDF 文件' })
          return
        }
        setPdfFile(file)
      }
    }

  const handleVerify = async () => {
    if (!excelFile || !pdfFile) {
      notify({ type: 'error', title: '请先上传 Excel 和 PDF 文件' })
      return
    }

    setVerifying(true)
    setResult(null)

    try {
      const formData = new FormData()
      formData.append('excel_file', excelFile)
      formData.append('pdf_file', pdfFile)

      const response = await fetch('/api/backend/api/v1/report-reconciliation/reconcile', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || '核对失败')
      }

      const data = await response.json()
      setResult(data)

      if (data.match_rate === 100) {
        notify({ type: 'success', title: '核对完成', message: '所有数据项均匹配' })
      } else if (data.mismatched_items > 0) {
        notify({
          type: 'warning',
          title: '核对完成',
          message: `发现 ${data.mismatched_items} 项差异，请检查`,
        })
      }
    } catch (error) {
      notify({
        type: 'error',
        title: '核对失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setVerifying(false)
    }
  }

  const handleReset = () => {
    setExcelFile(null)
    setPdfFile(null)
    setResult(null)
  }

  return (
    <div className={styles.stack} data-warm-manual-reconcile="true">
      <section className={styles.panel} aria-label="上传报表文件">
        <div className={styles.panelHeader}>
          <h2>上传报表文件</h2>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.uploadColumns}>
            <div className={styles.uploadColumn}>
              <div className={styles.fieldHeading}>
                <label>月度财务报表 (Excel)</label>
                <p>
                  上传系统生成的 Excel 报表，请确保包含「报表核算」工作表
                </p>
              </div>
              <div
                className={styles.fileDrop}
                data-selected={excelFile ? 'true' : 'false'}
              >
                <label>
                  <FileText
                    className={cn(styles.fileDropIcon, excelFile && styles.iconPositive)}
                  />
                  <div className={styles.fileDropLabel}>
                    {excelFile ? (
                      <span className={styles.positiveText}>
                        {excelFile.name}
                      </span>
                    ) : (
                      <>
                        <span className={styles.accentText}>点击选择文件</span> 或拖拽文件到此处
                      </>
                    )}
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={handleFileChange('excel')}
                  />
                </label>
              </div>
            </div>

            <div className={styles.uploadColumn}>
              <div className={styles.fieldHeading}>
                <label>月度结算摘要 (PDF)</label>
                <p>
                  上传亚马逊平台生成的月度结算摘要 PDF
                </p>
              </div>
              <div
                className={styles.fileDrop}
                data-selected={pdfFile ? 'true' : 'false'}
              >
                <label>
                  <FileUp
                    className={cn(styles.fileDropIcon, pdfFile && styles.iconPositive)}
                  />
                  <div className={styles.fileDropLabel}>
                    {pdfFile ? (
                      <span className={styles.positiveText}>
                        {pdfFile.name}
                      </span>
                    ) : (
                      <>
                        <span className={styles.accentText}>点击选择文件</span> 或拖拽文件到此处
                      </>
                    )}
                  </div>
                  <input
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handleFileChange('pdf')}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className={styles.actionRow}>
            <WarmButton variant="secondary" onClick={handleReset} disabled={verifying}>
              重置
            </WarmButton>
            <WarmButton
              variant="primary"
              onClick={handleVerify}
              disabled={verifying || !excelFile || !pdfFile}
            >
              {verifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  核对中...
                </>
              ) : (
                '开始核对'
              )}
            </WarmButton>
          </div>
        </div>
      </section>

      {result && (
        <>
          <div className={styles.sectionHeader}>
            <h2>核对结果</h2>
            <WarmBadge
              tone={result.match_rate === 100 ? 'positive' : 'accent'}
              className={styles.matchBadge}
            >
              {result.match_rate === 100 ? (
                <>
                  <CheckCircle2 className={styles.inlineIcon} />
                  全部匹配
                </>
              ) : (
                <>
                  <AlertCircle className={styles.inlineIcon} />
                  {result.matched_items}/{result.total_items} 匹配
                </>
              )}
            </WarmBadge>
          </div>

          <SummaryCard result={result} />

          <section className={styles.panel} aria-label="明细核对">
            <div className={styles.panelHeader}>
              <h2>明细核对</h2>
            </div>
            <div className={styles.tablePanelBody}>
              <div className={styles.tableScroll} data-warm-table-scroll="true">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th className={styles.numericCell}>Excel</th>
                      <th className={styles.numericCell}>PDF</th>
                      <th className={styles.numericCell}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((item, index) => (
                      <ResultItem key={index} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

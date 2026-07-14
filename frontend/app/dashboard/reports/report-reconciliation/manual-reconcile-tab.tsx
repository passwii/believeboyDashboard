'use client'

import { useState, useEffect, useRef } from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, FileText, FileUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

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
  const borderColor = isMatch
    ? 'border-emerald-200 dark:border-emerald-800/50'
    : 'border-red-200 dark:border-red-800/50'
  const rowBg = isMatch ? 'bg-emerald-50 dark:bg-emerald-900/10' : 'bg-red-50 dark:bg-red-900/10'

  return (
    <tr className={`transition-colors ${rowBg}`}>
      <td className={`border-r px-4 py-3 ${borderColor}`}>
        <div className="flex items-center gap-2">
          {isMatch ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-red-500" />
          )}
          <span className="font-medium text-sm">{label}</span>
        </div>
      </td>
      <td
        className={`border-r px-4 py-3 text-right font-mono ${borderColor} ${isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'}`}
      >
        {formatCurrency(item.excel_value)}
      </td>
      <td
        className={`border-r px-4 py-3 text-right font-mono ${borderColor} ${isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'}`}
      >
        {formatCurrency(item.pdf_value)}
      </td>
      <td className={`px-4 py-3 text-right ${borderColor}`}>
        {isMatch ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">OK</span>
        ) : (
          <span className="text-xs font-medium text-red-600 dark:text-red-400">
            差异: {formatCurrency(item.difference)}
            {item.difference_percent !== null && (
              <span className="ml-1 text-muted-foreground">({item.difference_percent}%)</span>
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
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-lg border bg-[hsl(var(--surface-subtle))] p-4">
        <div className="text-sm text-muted-foreground">收入合计</div>
        <div className="mt-1 font-mono text-2xl font-semibold">
          {formatCurrency(summary.excel_total_income)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          PDF: {formatCurrency(summary.pdf_total_income)}
        </div>
      </div>
      <div className="rounded-lg border bg-[hsl(var(--surface-subtle))] p-4">
        <div className="text-sm text-muted-foreground">支出合计</div>
        <div className="mt-1 font-mono text-2xl font-semibold">
          {formatCurrency(summary.excel_total_expense)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          PDF: {formatCurrency(summary.pdf_total_expense)}
        </div>
      </div>
      <div className="rounded-lg border bg-[hsl(var(--surface-subtle))] p-4">
        <div className="text-sm text-muted-foreground">净收款</div>
        <div className="mt-1 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
          {formatCurrency(summary.excel_net_amount)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
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
    <div className="space-y-6">
      <DataCard className="overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
        <DataCardHeader title="上传报表文件" />
        <DataCardContent className="p-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">月度财务报表 (Excel)</label>
                <p className="mt-1 text-xs text-muted-foreground">
                  上传系统生成的 Excel 报表，请确保包含「报表核算」工作表
                </p>
              </div>
              <div
                className={`flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                  excelFile
                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20'
                    : 'border-border hover:border-primary/50 hover:bg-[hsl(var(--surface-subtle))]'
                }`}
              >
                <label className="cursor-pointer text-center">
                  <FileText
                    className={`mx-auto h-12 w-12 ${
                      excelFile ? 'text-emerald-500' : 'text-muted-foreground'
                    }`}
                  />
                  <div className="mt-2 text-sm">
                    {excelFile ? (
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {excelFile.name}
                      </span>
                    ) : (
                      <>
                        <span className="text-primary">点击选择文件</span> 或拖拽文件到此处
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

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">月度结算摘要 (PDF)</label>
                <p className="mt-1 text-xs text-muted-foreground">
                  上传亚马逊平台生成的月度结算摘要 PDF
                </p>
              </div>
              <div
                className={`flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                  pdfFile
                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20'
                    : 'border-border hover:border-primary/50 hover:bg-[hsl(var(--surface-subtle))]'
                }`}
              >
                <label className="cursor-pointer text-center">
                  <FileUp
                    className={`mx-auto h-12 w-12 ${
                      pdfFile ? 'text-emerald-500' : 'text-muted-foreground'
                    }`}
                  />
                  <div className="mt-2 text-sm">
                    {pdfFile ? (
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {pdfFile.name}
                      </span>
                    ) : (
                      <>
                        <span className="text-primary">点击选择文件</span> 或拖拽文件到此处
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

          <div className="mt-6 flex justify-center gap-4">
            <Button variant="outline" onClick={handleReset} disabled={verifying}>
              重置
            </Button>
            <Button onClick={handleVerify} disabled={verifying || !excelFile || !pdfFile}>
              {verifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  核对中...
                </>
              ) : (
                '开始核对'
              )}
            </Button>
          </div>
        </DataCardContent>
      </DataCard>

      {result && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">核对结果</h2>
            <Badge
              variant="outline"
              className={
                result.match_rate === 100
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                  : 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              }
            >
              {result.match_rate === 100 ? (
                <>
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  全部匹配
                </>
              ) : (
                <>
                  <AlertCircle className="mr-1 h-4 w-4" />
                  {result.matched_items}/{result.total_items} 匹配
                </>
              )}
            </Badge>
          </div>

          <SummaryCard result={result} />

          <DataCard className="overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
            <DataCardHeader title="明细核对" />
            <DataCardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <th className="border-r px-4 py-3 text-left">字段</th>
                      <th className="border-r px-4 py-3 text-right">Excel</th>
                      <th className="border-r px-4 py-3 text-right">PDF</th>
                      <th className="px-4 py-3 text-right">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((item, index) => (
                      <ResultItem key={index} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            </DataCardContent>
          </DataCard>
        </>
      )}
    </div>
  )
}

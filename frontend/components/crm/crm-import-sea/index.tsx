'use client'

import { useMemo, useState } from 'react'
import { ClipboardPaste, Download, FileUp, Upload } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WarmCrmRecordDrawer } from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import type { CustomerSeaImportRow, CustomerSeaImportResult } from '@/lib/crm/types'
import { parseTsv, rowsFromGrid, validateRows } from './parse'
import { downloadFailureDetail, downloadImportTemplate } from './template'
import type { ImportStep, RowIssue } from './types'

import styles from './crm-import-sea-warm.module.css'

export interface CrmImportSeaProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported?: () => void
}

/** 公海导入客户：粘贴 / 上传 Excel → 预览校验 → 导入 → 结果（含失败明细下载）。 */
export function CrmImportSea({ open, onOpenChange, onImported }: CrmImportSeaProps) {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const [step, setStep] = useState<ImportStep>('input')
  const [pasteText, setPasteText] = useState('')
  const [rows, setRows] = useState<CustomerSeaImportRow[]>([])
  const [issues, setIssues] = useState<RowIssue[]>([])
  const [missingName, setMissingName] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CustomerSeaImportResult | null>(null)

  const errorRows = useMemo(
    () => new Set(issues.filter((i) => i.level === 'error').map((i) => i.row)),
    [issues]
  )
  const validRows = useMemo(() => rows.filter((_, i) => !errorRows.has(i + 1)), [rows, errorRows])

  function reset() {
    setStep('input')
    setPasteText('')
    setRows([])
    setIssues([])
    setMissingName(false)
    setResult(null)
  }

  function applyGrid(grid: string[][]) {
    const parsed = rowsFromGrid(grid)
    setMissingName(parsed.missingName)
    setRows(parsed.rows)
    setIssues(validateRows(parsed.rows))
    if (!parsed.missingName) setStep('preview')
  }

  async function handleFile(file: File) {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    const sheet = wb.worksheets[0]
    if (!sheet) return
    const grid: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      grid.push((row.values as unknown[]).slice(1).map((v) => String(v ?? '')))
    })
    applyGrid(grid)
  }

  function removeRow(idx: number) {
    const next = rows.filter((_, i) => i !== idx)
    setRows(next)
    setIssues(validateRows(next))
  }

  async function handleConfirm() {
    setSubmitting(true)
    try {
      const res = await client.importCustomersToSea(validRows)
      setResult(res)
      setStep('result')
      if (res.created > 0) {
        notify({ type: 'success', title: '导入完成', message: `成功导入 ${res.created} 个客户到公海` })
        onImported?.()
      }
    } catch (e) {
      notify({ type: 'error', title: '导入失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <WarmCrmRecordDrawer
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
      title="导入客户到公海"
    >
        <div className={styles.body}>
          {step === 'input' && (
            <div className="space-y-4">
              <div className={styles.intro}>
                <p className={styles.introText}>
                  粘贴 Excel 复制的内容，或上传 .xlsx 文件。导入的客户进入公海，全员可领取。
                </p>
                <WarmButton onClick={() => void downloadImportTemplate()}>
                  <Download className="h-4 w-4" aria-hidden="true" /> 下载模板
                </WarmButton>
              </div>
              <Tabs defaultValue="paste">
                <TabsList className={styles.tabsList}>
                  <TabsTrigger value="paste" className={styles.tab}>
                    <ClipboardPaste aria-hidden />
                    粘贴
                  </TabsTrigger>
                  <TabsTrigger value="upload" className={styles.tab}>
                    <FileUp aria-hidden />
                    上传 Excel
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="paste" className={styles.content}>
                  <Textarea
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="从 Excel 复制若干行（含表头「客户名」等）粘贴到此处…"
                    className={styles.textarea}
                  />
                  <WarmButton variant="primary" onClick={() => applyGrid(parseTsv(pasteText))} disabled={!pasteText.trim()}>
                    下一步
                  </WarmButton>
                </TabsContent>
                <TabsContent value="upload" className={styles.content}>
                  <label className={styles.upload}>
                    <Upload className="h-6 w-6" />
                    <span>点击选择 .xlsx / .xls 文件</span>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void handleFile(f)
                      }}
                    />
                  </label>
                </TabsContent>
              </Tabs>
              {missingName && (
                <p className={styles.errorText} role="alert">
                  缺少「客户名」列，无法解析，请检查表头。
                </p>
              )}
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-3">
              <p className="text-sm">
                共 {rows.length} 行 · {errorRows.size} 行有误
                {errorRows.size > 0 && (
                  <span className={styles.mutedText}>（确认导入将跳过错误行）</span>
                )}
              </p>
              <div className={styles.preview}>
                <table>
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">客户名</th>
                      <th className="px-2 py-1 text-left">等级</th>
                      <th className="px-2 py-1 text-left">联系人</th>
                      <th className="px-2 py-1 text-left">状态</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const rowIssues = issues.filter((x) => x.row === i + 1)
                      const err = rowIssues.find((x) => x.level === 'error')
                      const warn = rowIssues.find((x) => x.level === 'warn')
                      return (
                        <tr key={i} className={err ? styles.rowError : undefined}>
                          <td className={styles.mutedText}>{i + 1}</td>
                          <td className="px-2 py-1">
                            {r.name || <span className={styles.errorText}>（空）</span>}
                          </td>
                          <td className="px-2 py-1">{r.rating ?? '-'}</td>
                          <td className="px-2 py-1">{r.contactName ?? '-'}</td>
                          <td className="px-2 py-1">
                            {err ? (
                              <span className={styles.errorText}>{err.message}</span>
                            ) : warn ? (
                              <span className={styles.warningText}>{warn.message}</span>
                            ) : (
                              <span className={styles.successText}>✓</span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            <button
                              type="button"
                              className={styles.remove}
                              onClick={() => removeRow(i)}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.actions}>
                <WarmButton onClick={() => setStep('input')}>
                  返回
                </WarmButton>
                <WarmButton variant="primary" onClick={() => void handleConfirm()} disabled={submitting || validRows.length === 0}>
                  {submitting ? '导入中…' : `确认导入（${validRows.length}）`}
                </WarmButton>
              </div>
            </div>
          )}

          {step === 'result' && result && (
            <div className="space-y-4">
              <div className={styles.result}>
                <FileUp className={styles.resultIcon} />
                <p className="text-sm">
                  成功 {result.created} · 跳过 {result.skippedDupes}（已存在）· 失败 {result.failed.length}
                </p>
              </div>
              {result.failed.length > 0 && (
                <WarmButton
                  onClick={() => void downloadFailureDetail(result.failed, rows)}
                >
                  <Download className="h-4 w-4" aria-hidden="true" /> 下载失败明细
                </WarmButton>
              )}
              <div className={styles.actions}>
                <WarmButton
                  variant="primary"
                  onClick={() => {
                    reset()
                    onOpenChange(false)
                  }}
                >
                  完成
                </WarmButton>
              </div>
            </div>
          )}
        </div>
    </WarmCrmRecordDrawer>
  )
}

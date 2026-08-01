'use client'

import { useMemo, useState } from 'react'
import { Download, FileUp, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import type { CustomerSeaImportRow, CustomerSeaImportResult } from '@/lib/crm/types'
import { parseTsv, rowsFromGrid, validateRows } from './parse'
import { downloadFailureDetail, downloadImportTemplate } from './template'
import type { ImportStep, RowIssue } from './types'

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
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle>导入客户到公海</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 'input' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  粘贴 Excel 复制的内容，或上传 .xlsx 文件。导入的客户进入公海，全员可领取。
                </p>
                <Button variant="outline" size="sm" onClick={() => void downloadImportTemplate()}>
                  <Download className="mr-1 h-4 w-4" /> 下载模板
                </Button>
              </div>
              <Tabs defaultValue="paste">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="paste">粘贴</TabsTrigger>
                  <TabsTrigger value="upload">上传 Excel</TabsTrigger>
                </TabsList>
                <TabsContent value="paste" className="space-y-3">
                  <Textarea
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="从 Excel 复制若干行（含表头「客户名」等）粘贴到此处…"
                  />
                  <Button onClick={() => applyGrid(parseTsv(pasteText))} disabled={!pasteText.trim()}>
                    下一步
                  </Button>
                </TabsContent>
                <TabsContent value="upload" className="space-y-3">
                  <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground hover:bg-muted/40">
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
                <p className="text-sm text-rose-600" role="alert">
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
                  <span className="ml-1 text-muted-foreground">（确认导入将跳过错误行）</span>
                )}
              </p>
              <div className="max-h-80 overflow-auto rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60">
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
                        <tr key={i} className={err ? 'bg-rose-50 dark:bg-rose-950/30' : undefined}>
                          <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                          <td className="px-2 py-1">
                            {r.name || <span className="text-rose-600">（空）</span>}
                          </td>
                          <td className="px-2 py-1">{r.rating ?? '-'}</td>
                          <td className="px-2 py-1">{r.contactName ?? '-'}</td>
                          <td className="px-2 py-1">
                            {err ? (
                              <span className="text-rose-600">{err.message}</span>
                            ) : warn ? (
                              <span className="text-amber-600">{warn.message}</span>
                            ) : (
                              <span className="text-emerald-600">✓</span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            <button
                              type="button"
                              className="text-xs text-muted-foreground hover:text-rose-600"
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
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep('input')}>
                  返回
                </Button>
                <Button onClick={() => void handleConfirm()} disabled={submitting || validRows.length === 0}>
                  {submitting ? '导入中…' : `确认导入（${validRows.length}）`}
                </Button>
              </div>
            </div>
          )}

          {step === 'result' && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FileUp className="h-5 w-5 text-emerald-600" />
                <p className="text-sm">
                  成功 {result.created} · 跳过 {result.skippedDupes}（已存在）· 失败 {result.failed.length}
                </p>
              </div>
              {result.failed.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadFailureDetail(result.failed, rows)}
                >
                  <Download className="mr-1 h-4 w-4" /> 下载失败明细
                </Button>
              )}
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    reset()
                    onOpenChange(false)
                  }}
                >
                  完成
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

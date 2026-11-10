'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import type { IntentImportResult } from '@/lib/crm/intent/types'
import { todayDateStamp } from '@/lib/crm/intent/format'
import { apiErrorMessage } from '@/lib/crm/intent/http-client'
import { useIntentClient } from '@/lib/crm/intent/provider'

import { IntentDialog } from './intent-dialog'

import styles from '../intent-warm.module.css'

type ImportBatchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (result: IntentImportResult) => void
}

const ACCEPT = '.json,.csv,.xlsx'

/** 人工导入批次 Dialog（仅 admin；字段契约与 Agent JSON 导入一致，由服务端解析）。 */
export function ImportBatchDialog({ open, onOpenChange, onImported }: ImportBatchDialogProps) {
  const client = useIntentClient()
  const { notify } = useNotifications()
  const [file, setFile] = useState<File | null>(null)
  const [batchDate, setBatchDate] = useState(todayDateStamp())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IntentImportResult | null>(null)

  const reset = () => {
    setFile(null)
    setBatchDate(todayDateStamp())
    setError(null)
    setResult(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const issueRows = result
    ? result.rows.filter(
        (row) =>
          row.reason ||
          row.status === 'rejected' ||
          row.status === 'skipped_locked' ||
          row.status === 'skipped_existing'
      )
    : []

  const handleSubmit = async () => {
    if (!file) {
      setError('请选择 JSON / CSV / XLSX 文件')
      return
    }
    setSubmitting(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    form.append('batch_date', batchDate)
    try {
      const importResult = await client.uploadBatch(form)
      setResult(importResult)
      notify({
        type: 'success',
        title: '批次导入完成',
        message: `新增 ${importResult.createdCount} · 更新 ${importResult.updatedCount} · 跳过已存在 ${importResult.skippedExistingCount} · 跳过锁定 ${importResult.skippedLockedCount} · 拒绝 ${importResult.rejectedCount}`,
      })
      onImported(importResult)
      setFile(null)
    } catch (reason) {
      setError(apiErrorMessage(reason, '批次导入失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <IntentDialog
      description="上传筛选流水线产出的 JSON / CSV / XLSX。字段契约与 AI 导入一致；已锁定记录会被跳过。"
      footer={
        <>
          <WarmButton onClick={() => handleOpenChange(false)}>关闭</WarmButton>
          <WarmButton
            disabled={!file || submitting}
            loading={submitting}
            variant="primary"
            onClick={() => void handleSubmit()}
          >
            导入
          </WarmButton>
        </>
      }
      open={open}
      title="导入批次"
      onOpenChange={handleOpenChange}
    >
      <div className={styles.importForm}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>批次文件</span>
          <div className={styles.fileRow}>
            <label className="warm-ledger__button warm-ledger__button--secondary">
              选择文件
              <input
                accept={ACCEPT}
                aria-label="批次文件"
                className={styles.fileInput}
                type="file"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null)
                  setResult(null)
                  setError(null)
                }}
              />
            </label>
            <span className={styles.fileName}>{file?.name ?? '未选择文件'}</span>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>批次日期</span>
          <input
            aria-label="批次日期"
            className={styles.input}
            type="date"
            value={batchDate}
            onChange={(event) => setBatchDate(event.target.value)}
          />
        </label>

        {error ? (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className={styles.importResult} role="status">
            <p className={styles.importSummary}>
              批次 #{result.batchId ?? '—'} · 企业 {result.totalCompanies} · 待筛 {result.totalPool}
            </p>
            <p className={styles.importSummary}>
              新增 {result.createdCount} · 更新 {result.updatedCount} · 跳过已存在{' '}
              {result.skippedExistingCount} · 跳过锁定 {result.skippedLockedCount} · 拒绝{' '}
              {result.rejectedCount}
            </p>
            {issueRows.length > 0 ? (
              <ul className={styles.importRows}>
                {issueRows.slice(0, 10).map((row, index) => (
                  <li key={`${row.scope ?? 'row'}-${row.index ?? '?'}-${index}`}>
                    {row.scope === 'pool' ? '待筛池' : '企业'} 第 {row.index ?? '—'} 行
                    {row.externalId ? ` · ${row.externalId}` : ''}
                    {row.status ? `（${row.status}）` : ''}：{row.reason || '—'}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.rowsTruncated ? (
              <p className={styles.importSummary}>逐行结果已截断，仅记录前若干行。</p>
            ) : null}
          </div>
        ) : null}

        {!result && !error ? (
          <p className={styles.drawerHint}>
            文件大于 4.5MB 时请改走 AI server-to-server 接口导入。
          </p>
        ) : null}
      </div>
    </IntentDialog>
  )
}

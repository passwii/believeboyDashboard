'use client'

import { useRef, useState } from 'react'
import { FileUp, X } from 'lucide-react'

import { WarmButton, WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB } from '@/lib/crm/constants/proposal'
import {
  PROPOSAL_ACCEPT,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  type ProposalCreateInput,
  type ProposalFileFormat,
  type ProposalType,
  type ProposalVersionInput,
} from '@/lib/crm/types'

import styles from './proposal-warm.module.css'

const MAX_SIZE_MB = PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB
const WRONG_EXT_ERROR = '仅支持单个 HTML（.html / .htm）或 PDF（.pdf）文件'

export interface CustomerOption {
  id: string
  name: string
}

/** 按扩展名判定格式（与后端同口径：扩展名硬约束，MIME 只做软校验）。 */
function fileFormat(file: File): ProposalFileFormat | null {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.pdf')) return 'pdf'
  return null
}

/** 本地文件大小校验（后端也会再校一次，这里只是即时反馈）。 */
function sizeError(file: File | null): string | null {
  if (!file) return null
  if (file.size === 0) return '文件为空'
  if (file.size > MAX_SIZE_MB * 1024 * 1024) return `文件超过 ${MAX_SIZE_MB} MB 上限`
  return null
}

/** 通用的「选单个 HTML / PDF」输入：受控文件名 + 本地校验提示。 */
function FileField({
  file,
  onPick,
  disabled,
  testId,
}: {
  file: File | null
  onPick: (file: File | null) => void
  disabled?: boolean
  testId?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={styles.fileRow}>
      <input
        ref={inputRef}
        type="file"
        accept={PROPOSAL_ACCEPT}
        className={styles.fileInput}
        data-testid={testId}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <WarmButton disabled={disabled} onClick={() => inputRef.current?.click()}>
        <FileUp aria-hidden="true" />
        选择文件
      </WarmButton>
      {file ? (
        <span className={styles.fileNameGroup}>
          <span className={styles.fileName} title={file.name}>
            {file.name}
          </span>
          <WarmIconButton
            aria-label="移除文件"
            disabled={disabled}
            onClick={() => {
              onPick(null)
              if (inputRef.current) inputRef.current.value = ''
            }}
          >
            <X aria-hidden="true" />
          </WarmIconButton>
        </span>
      ) : (
        <span className={styles.filePlaceholder}>未选择文件</span>
      )}
    </div>
  )
}

export interface ProposalCreateFormProps {
  customers: CustomerOption[]
  submitting?: boolean
  onSubmit: (input: ProposalCreateInput) => void | Promise<void>
  submitText?: string
}

/** 新建方案（首版）：单个 HTML / PDF + 标题 / 类型 / 关联客户。 */
export function ProposalCreateForm({
  customers,
  submitting = false,
  onSubmit,
  submitText = '上传并创建',
}: ProposalCreateFormProps) {
  const [file, setFile] = useState<File | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [proposalType, setProposalType] = useState<ProposalType>('other')
  const [customerId, setCustomerId] = useState('')
  const [touched, setTouched] = useState(false)

  const error = pickerError ?? sizeError(file)
  const canSubmit = file !== null && !error && !submitting

  const onPick = (selected: File | null) => {
    if (!selected) {
      setFile(null)
      setPickerError(null)
      return
    }
    if (!fileFormat(selected)) {
      setFile(null)
      setPickerError(WRONG_EXT_ERROR)
      return
    }
    setFile(selected)
    setPickerError(null)
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!canSubmit || !file) return
        void onSubmit({
          file,
          title: title.trim() || undefined,
          proposalType,
          customerId: customerId || null,
        })
      }}
    >
      <FileField file={file} onPick={onPick} disabled={submitting} testId="proposal-file-input" />
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>标题（留空则用文件名）</span>
        <input
          className={styles.input}
          value={title}
          maxLength={200}
          disabled={submitting}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：亚马逊代运营入驻方案"
        />
      </label>

      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span className={styles.label}>方案类型</span>
          <select
            className={styles.select}
            value={proposalType}
            disabled={submitting}
            onChange={(e) => setProposalType(e.target.value as ProposalType)}
          >
            {PROPOSAL_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {PROPOSAL_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>关联客户（可选）</span>
          <select
            className={styles.select}
            value={customerId}
            disabled={submitting}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">不关联</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {touched && !file ? (
        <p role="alert" className={styles.errorText}>
          请选择要上传的 HTML 或 PDF 文件
        </p>
      ) : null}

      <div className={styles.formActions}>
        <WarmButton type="submit" variant="primary" disabled={!canSubmit} loading={submitting}>
          {submitText}
        </WarmButton>
      </div>
    </form>
  )
}

export interface ProposalVersionFormProps {
  submitting?: boolean
  onSubmit: (input: ProposalVersionInput) => void | Promise<void>
}

/** 追加新版本：单个 HTML / PDF + 变更说明。 */
export function ProposalVersionForm({
  submitting = false,
  onSubmit,
}: ProposalVersionFormProps) {
  const [file, setFile] = useState<File | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState('')
  const [touched, setTouched] = useState(false)

  const error = pickerError ?? sizeError(file)
  const canSubmit = file !== null && !error && !submitting

  const onPick = (selected: File | null) => {
    if (!selected) {
      setFile(null)
      setPickerError(null)
      return
    }
    if (!fileFormat(selected)) {
      setFile(null)
      setPickerError(WRONG_EXT_ERROR)
      return
    }
    setFile(selected)
    setPickerError(null)
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!canSubmit || !file) return
        void onSubmit({ file, changeNote: changeNote.trim() || undefined })
      }}
    >
      <FileField file={file} onPick={onPick} disabled={submitting} testId="proposal-version-file" />
      {error ? (
        <p role="alert" className={styles.errorText}>
          {error}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>变更说明（可选）</span>
        <input
          className={styles.input}
          value={changeNote}
          maxLength={500}
          disabled={submitting}
          onChange={(e) => setChangeNote(e.target.value)}
          placeholder="例如：补充服务范围与报价区间"
        />
      </label>

      {touched && !file ? (
        <p role="alert" className={styles.errorText}>
          请选择要上传的 HTML 或 PDF 文件
        </p>
      ) : null}

      <div className={styles.formActions}>
        <WarmButton type="submit" variant="primary" disabled={!canSubmit} loading={submitting}>
          上传新版本
        </WarmButton>
      </div>
    </form>
  )
}

'use client'

import { useRef, useState } from 'react'
import { FileUp, Loader2, X } from 'lucide-react'

import {
  TERM_BUTTON,
  TERM_INPUT,
  TERM_SELECT_NATIVE,
} from '@/components/crm/term-shared'
import { cn } from '@/lib/utils'
import { PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB } from '@/lib/crm/constants/proposal'
import {
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  type ProposalCreateInput,
  type ProposalType,
  type ProposalVersionInput,
} from '@/lib/crm/types'

const MAX_SIZE_MB = PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB
const WRONG_EXT_ERROR = '仅支持单个 HTML 文件（.html / .htm）'

export interface CustomerOption {
  id: string
  name: string
}

function isHtmlFile(file: File): boolean {
  const lower = file.name.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

/** 本地文件大小校验（后端也会再校一次，这里只是即时反馈）。 */
function sizeError(file: File | null): string | null {
  if (!file) return null
  if (file.size === 0) return '文件为空'
  if (file.size > MAX_SIZE_MB * 1024 * 1024) return `文件超过 ${MAX_SIZE_MB} MB 上限`
  return null
}

/** 通用的「选单个 HTML」输入：受控文件名 + 本地校验提示。 */
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
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".html,.htm,text/html"
        className="hidden"
        data-testid={testId}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={cn(TERM_BUTTON, 'gap-1.5')}
      >
        <FileUp className="h-3.5 w-3.5" />
        选择 HTML
      </button>
      {file ? (
        <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-term-text">
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <button
            type="button"
            aria-label="移除文件"
            disabled={disabled}
            onClick={() => {
              onPick(null)
              if (inputRef.current) inputRef.current.value = ''
            }}
            className="text-term-faint hover:text-term-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : (
        <span className="font-mono text-xs text-term-faint">未选择文件</span>
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

/** 新建方案（首版）：单个 HTML + 标题 / 类型 / 关联客户。 */
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
    if (!isHtmlFile(selected)) {
      setFile(null)
      setPickerError(WRONG_EXT_ERROR)
      return
    }
    setFile(selected)
    setPickerError(null)
  }

  return (
    <form
      className="flex flex-col gap-3"
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
        <p role="alert" className="font-mono text-xs text-term-neg">
          {error}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-term-muted">标题（留空则用文件名）</span>
        <input
          className={TERM_INPUT}
          value={title}
          maxLength={200}
          disabled={submitting}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：亚马逊代运营入驻方案"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <span className="font-mono text-xs text-term-muted">方案类型</span>
          <select
            className={TERM_SELECT_NATIVE}
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

        <label className="flex min-w-[200px] flex-[2] flex-col gap-1">
          <span className="font-mono text-xs text-term-muted">关联客户（可选）</span>
          <select
            className={TERM_SELECT_NATIVE}
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
        <p role="alert" className="font-mono text-xs text-term-neg">
          请选择要上传的 HTML 文件
        </p>
      ) : null}

      <div className="flex justify-end">
        <button type="submit" disabled={!canSubmit} className={cn(TERM_BUTTON, 'gap-1.5')}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitText}
        </button>
      </div>
    </form>
  )
}

export interface ProposalVersionFormProps {
  submitting?: boolean
  onSubmit: (input: ProposalVersionInput) => void | Promise<void>
}

/** 追加新版本：单个 HTML + 变更说明。 */
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
    if (!isHtmlFile(selected)) {
      setFile(null)
      setPickerError(WRONG_EXT_ERROR)
      return
    }
    setFile(selected)
    setPickerError(null)
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!canSubmit || !file) return
        void onSubmit({ file, changeNote: changeNote.trim() || undefined })
      }}
    >
      <FileField file={file} onPick={onPick} disabled={submitting} testId="proposal-version-file" />
      {error ? (
        <p role="alert" className="font-mono text-xs text-term-neg">
          {error}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-term-muted">变更说明（可选）</span>
        <input
          className={TERM_INPUT}
          value={changeNote}
          maxLength={500}
          disabled={submitting}
          onChange={(e) => setChangeNote(e.target.value)}
          placeholder="例如：补充服务范围与报价区间"
        />
      </label>

      {touched && !file ? (
        <p role="alert" className="font-mono text-xs text-term-neg">
          请选择要上传的 HTML 文件
        </p>
      ) : null}

      <div className="flex justify-end">
        <button type="submit" disabled={!canSubmit} className={cn(TERM_BUTTON, 'gap-1.5')}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          上传新版本
        </button>
      </div>
    </form>
  )
}

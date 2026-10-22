'use client'

import { useState } from 'react'
import { Download, Eye, Loader2, Upload } from 'lucide-react'

import { TERM_BUTTON } from '@/components/crm/term-shared'
import { cn } from '@/lib/utils'
import {
  formatFileSize,
  proposalFileFormat,
  type ProposalVersion,
} from '@/lib/crm/types'

/** 上传 accept（HTML / PDF）——由 types 统一维护，避免两处口径漂移。 */
export { PROPOSAL_ACCEPT } from '@/lib/crm/types'

export interface ProposalVersionTimelineProps {
  versions: ProposalVersion[]
  currentVersionNo: number
  /** 正在预览的版本号（高亮）。 */
  selectedVersionNo: number
  onSelect: (versionNo: number) => void
  onDownload: (versionNo: number, opts?: { raw?: boolean }) => void
  /** 正在下载的版本号（禁用 + spinner）。 */
  downloadingVersionNo?: number | null
  className?: string
}

/**
 * 版本时间线（新→旧）：点行切换预览；每行可下载「适配版 / 原始版」。
 * 版本 append-only，不可改写——这里只读。
 */
export function ProposalVersionTimeline({
  versions,
  currentVersionNo,
  selectedVersionNo,
  onSelect,
  onDownload,
  downloadingVersionNo = null,
  className,
}: ProposalVersionTimelineProps) {
  if (versions.length === 0) {
    return <div className="px-2 py-6 text-center font-mono text-xs text-term-faint">暂无版本</div>
  }
  return (
    <ol className={cn('flex flex-col gap-1', className)} data-testid="proposal-version-timeline">
      {versions.map((v) => {
        const isSelected = v.versionNo === selectedVersionNo
        const format = proposalFileFormat(v)
        return (
          <li
            key={v.id}
            data-testid={`proposal-version-${v.versionNo}`}
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 border px-2 py-1.5',
              isSelected
                ? 'border-term-border-strong bg-term-raised'
                : 'border-term-border bg-term-panel'
            )}
          >
            <button
              type="button"
              data-testid={`proposal-version-select-${v.versionNo}`}
              onClick={() => onSelect(v.versionNo)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-current={isSelected}
            >
              <span className="shrink-0 font-mono text-xs text-term-text">v{v.versionNo}</span>
              {v.versionNo === currentVersionNo ? (
                <span className="shrink-0 border border-current/30 px-1 font-mono text-[10px] text-term-pos">
                  当前
                </span>
              ) : null}
              <span className="min-w-0 truncate text-xs text-term-muted" title={v.changeNote ?? v.originalFilename}>
                {v.changeNote || v.originalFilename}
              </span>
              {format === 'pdf' ? (
                <span className="shrink-0 border border-current/30 px-1 font-mono text-[10px] text-term-muted">
                  PDF
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-[11px] text-term-faint">
                {formatFileSize(v.fileSize)}
              </span>
            </button>

            <span className="shrink-0 font-mono text-[11px] text-term-faint">
              {new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}
            </span>

            <button
              type="button"
              onClick={() => onSelect(v.versionNo)}
              className={cn(TERM_BUTTON, 'h-7 px-1.5')}
              aria-label={`预览 v${v.versionNo}`}
              title="预览"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDownload(v.versionNo)}
              disabled={downloadingVersionNo === v.versionNo}
              className={cn(TERM_BUTTON, 'h-7 px-1.5')}
              aria-label={`下载 v${v.versionNo}`}
              title={format === 'pdf' ? '下载 PDF' : '下载（适配版）'}
            >
              {downloadingVersionNo === v.versionNo ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
            </button>
            {format === 'html' ? (
              <button
                type="button"
                onClick={() => onDownload(v.versionNo, { raw: true })}
                className={cn(TERM_BUTTON, 'h-7 px-1.5')}
                aria-label={`下载 v${v.versionNo} 原始版`}
                title="下载原始上传版"
              >
                <Upload className="h-3.5 w-3.5 rotate-180" />
              </button>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

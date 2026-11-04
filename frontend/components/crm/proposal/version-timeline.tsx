'use client'

import { Download, Eye, Upload } from 'lucide-react'

import { WarmCrmState, WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'
import {
  formatFileSize,
  proposalFileFormat,
  type ProposalVersion,
} from '@/lib/crm/types'

import styles from './proposal-warm.module.css'

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
    return <WarmCrmState kind="empty" title="暂无版本" />
  }
  return (
    <ol className={cn(styles.timeline, className)} data-testid="proposal-version-timeline">
      {versions.map((v) => {
        const isSelected = v.versionNo === selectedVersionNo
        const format = proposalFileFormat(v)
        return (
          <li
            key={v.id}
            data-testid={`proposal-version-${v.versionNo}`}
            className={cn(styles.versionRow, isSelected && styles.versionRowSelected)}
          >
            <button
              type="button"
              data-testid={`proposal-version-select-${v.versionNo}`}
              onClick={() => onSelect(v.versionNo)}
              className={styles.versionSelect}
              aria-current={isSelected}
            >
              <span className={styles.versionNo}>v{v.versionNo}</span>
              {v.versionNo === currentVersionNo ? (
                <WarmCrmStatusPill tone="positive">当前</WarmCrmStatusPill>
              ) : null}
              <span
                className={styles.versionNote}
                title={v.changeNote ?? v.originalFilename}
              >
                {v.changeNote || v.originalFilename}
              </span>
              {format === 'pdf' ? (
                <WarmCrmStatusPill>PDF</WarmCrmStatusPill>
              ) : null}
              <span className={styles.versionSize}>{formatFileSize(v.fileSize)}</span>
            </button>

            <span className={styles.versionTime}>
              {new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}
            </span>

            <span className={styles.versionActions}>
              <WarmIconButton
                onClick={() => onSelect(v.versionNo)}
                aria-label={`预览 v${v.versionNo}`}
                title="预览"
              >
                <Eye aria-hidden="true" />
              </WarmIconButton>
              <WarmIconButton
                onClick={() => onDownload(v.versionNo)}
                loading={downloadingVersionNo === v.versionNo}
                aria-label={`下载 v${v.versionNo}`}
                title={format === 'pdf' ? '下载 PDF' : '下载（适配版）'}
              >
                <Download aria-hidden="true" />
              </WarmIconButton>
              {format === 'html' ? (
                <WarmIconButton
                  onClick={() => onDownload(v.versionNo, { raw: true })}
                  aria-label={`下载 v${v.versionNo} 原始版`}
                  title="下载原始上传版"
                >
                  <Upload aria-hidden="true" />
                </WarmIconButton>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

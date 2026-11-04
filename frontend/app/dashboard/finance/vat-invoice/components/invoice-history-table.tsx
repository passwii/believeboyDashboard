'use client'

import { Download, Eye, Ban } from 'lucide-react'
import {
  WarmBadge,
  WarmIconButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import type { VatInvoiceListItem } from '../lib/vat-history-api'
import styles from '../vat-invoice-warm.module.css'

interface Props {
  rows: VatInvoiceListItem[]
  onSelect: (id: number) => void
  onDownload: (id: number) => void
  onVoid: (id: number) => void
  loading?: boolean
}

const STATUS_LABEL: Record<VatInvoiceListItem['status'], string> = {
  draft: '草稿',
  issued: '已签发',
  voided: '已作废',
}

const STATUS_TONE: Record<VatInvoiceListItem['status'], WarmBadgeTone> = {
  draft: 'accent',
  issued: 'positive',
  voided: 'negative',
}

export function InvoiceHistoryTable({ rows, onSelect, onDownload, onVoid, loading }: Props) {
  if (loading) {
    return (
      <p className={styles.loadingState} role="status">
        加载中…
      </p>
    )
  }
  return (
    <div className={styles.tableScroller}>
      <table className={styles.table} data-warm-table="true">
        <thead className={styles.tableHead}>
          <tr>
            <th className={styles.tableHeaderCell}>发票号</th>
            <th className={styles.tableHeaderCell}>店铺</th>
            <th className={styles.tableHeaderCell}>买方</th>
            <th className={styles.tableHeaderCell}>货币</th>
            <th className={styles.tableHeaderCell}>日期</th>
            <th className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}>
              总额（含税）
            </th>
            <th className={styles.tableHeaderCell}>状态</th>
            <th className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className={styles.tableEmptyCell}>
                没有匹配的发票。
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className={styles.tableRow}>
                <td className={`${styles.tableCell} ${styles.tableCellMono}`}>{r.invoice_no}</td>
                <td className={styles.tableCell}>{r.project_name}</td>
                <td className={styles.tableCell} title={r.buyer_name}>
                  {r.buyer_name}
                </td>
                <td className={`${styles.tableCell} ${styles.tableCellMono}`}>
                  {r.currency}
                </td>
                <td className={`${styles.tableCell} ${styles.tableCellMono}`}>{r.invoice_date}</td>
                <td
                  className={`${styles.tableCell} ${styles.tableCellNumeric} ${styles.tableCellStrong}`}
                >
                  {r.total_incl}
                </td>
                <td className={styles.tableCell}>
                  <WarmBadge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</WarmBadge>
                </td>
                <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                  <span className={styles.tableActions}>
                    <WarmIconButton
                      className={styles.tableAction}
                      title="详情"
                      aria-label="详情"
                      onClick={() => onSelect(r.id)}
                    >
                      <Eye aria-hidden />
                    </WarmIconButton>
                    <WarmIconButton
                      className={styles.tableAction}
                      title="下载 PDF"
                      aria-label="下载 PDF"
                      onClick={() => onDownload(r.id)}
                      disabled={!r.has_pdf}
                    >
                      <Download aria-hidden />
                    </WarmIconButton>
                    <WarmIconButton
                      className={styles.tableAction}
                      title="作废"
                      aria-label="作废"
                      onClick={() => onVoid(r.id)}
                      disabled={r.status === 'voided'}
                    >
                      <Ban aria-hidden />
                    </WarmIconButton>
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

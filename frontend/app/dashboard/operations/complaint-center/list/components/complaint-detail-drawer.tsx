'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Loader2,
  MailWarning,
  MessageSquare,
  Pencil,
  ShieldCheck,
  ShoppingBag,
  X,
  XCircle,
} from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import {
  type ComplaintDetail,
  type ComplaintStatus,
  type ComplaintStatusChangePayload,
  changeComplaintStatus,
  fetchComplaintDetail,
} from '@/lib/complaint-api'
import styles from '../complaint-list-warm.module.css'

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  pending: '待回复',
  drafted: '已起草',
  replied: '已回复',
  resolved: '已解决',
  closed_no_response: '关闭无回复',
}

const STATUS_ICON: Record<ComplaintStatus, typeof MailWarning> = {
  pending: MailWarning,
  drafted: Pencil,
  replied: MessageSquare,
  resolved: CheckCircle2,
  closed_no_response: XCircle,
}

const STATUS_TONE: Record<
  ComplaintStatus,
  'accent' | 'positive' | 'negative' | 'muted'
> = {
  pending: 'accent',
  drafted: 'muted',
  replied: 'accent',
  resolved: 'positive',
  closed_no_response: 'negative',
}

const NEXT_STATUS: Record<ComplaintStatus, ComplaintStatus | null> = {
  pending: 'drafted',
  drafted: 'replied',
  replied: 'resolved',
  resolved: 'closed_no_response',
  closed_no_response: null,
}

const NEXT_STATUS_LABEL: Record<ComplaintStatus, string> = {
  pending: '标记已起草',
  replied: '标记已回复',
  drafted: '标记已回复',
  resolved: '标记已解决',
  closed_no_response: '',
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

interface ComplaintDetailDrawerProps {
  complaintId: number | null
  open: boolean
  onClose: () => void
  onStatusChanged: () => void
  projectNameById?: ReadonlyMap<number, string>
}

export function ComplaintDetailDrawer({
  complaintId,
  open,
  onClose,
  onStatusChanged,
  projectNameById,
}: ComplaintDetailDrawerProps) {
  const { notify } = useNotifications()
  const [detail, setDetail] = useState<ComplaintDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [handlerNote, setHandlerNote] = useState('')
  const [pendingStatus, setPendingStatus] = useState<ComplaintStatus | null>(null)

  const loadDetail = useCallback(async () => {
    if (complaintId == null) return
    setLoading(true)
    try {
      const result = await fetchComplaintDetail(complaintId, projectNameById)
      setDetail(result)
      setHandlerNote(result?.handler_note ?? '')
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: `加载详情失败: ${(err as Error).message}`,
      })
    } finally {
      setLoading(false)
    }
  }, [complaintId, projectNameById, notify])

  useEffect(() => {
    if (open && complaintId != null) {
      void loadDetail()
    } else if (!open) {
      setDetail(null)
      setHandlerNote('')
    }
  }, [open, complaintId, loadDetail])

  const handleCopyOrder = useCallback(
    (orderId: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) return
      navigator.clipboard
        .writeText(orderId)
        .then(() => {
          notify({ type: 'success', title: '已复制', message: `已复制订单号 ${orderId}` })
        })
        .catch(() => {
          notify({ type: 'error', title: '复制失败' })
        })
    },
    [notify]
  )

  const submitStatusChange = useCallback(
    async (status: ComplaintStatus) => {
      if (!detail) return
      setSubmitting(true)
      try {
        const payload: ComplaintStatusChangePayload = {
          status,
          handler_note: handlerNote || undefined,
        }
        await changeComplaintStatus(detail.id, payload, projectNameById)
        notify({
          type: 'success',
          title: '状态已更新',
          message: `状态已更新为「${STATUS_LABEL[status]}」`,
        })
        onStatusChanged()
        onClose()
      } catch (err) {
        notify({
          type: 'error',
          title: '更新失败',
          message: `状态更新失败: ${(err as Error).message}`,
        })
      } finally {
        setSubmitting(false)
        setPendingStatus(null)
      }
    },
    [detail, handlerNote, projectNameById, notify, onStatusChanged, onClose]
  )

  const isClosed = detail?.status === 'resolved' || detail?.status === 'closed_no_response'
  const nextStatus = detail?.status ? NEXT_STATUS[detail.status] : null

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent
        side="right"
        className={`${styles.drawer} w-full max-w-xl overflow-y-auto`}
        data-warm-complaint-drawer="true"
      >
        <SheetHeader className={styles.drawerHeader}>
          <SheetClose className={styles.drawerClose}>
            <X size={16} aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </SheetClose>
          <SheetTitle className={styles.drawerTitle}>
            <ShieldCheck size={18} aria-hidden="true" />
            客诉详情
            {detail ? <span className={styles.drawerMeta}>#{detail.id}</span> : null}
          </SheetTitle>
          <SheetDescription className={styles.drawerMeta}>
            {detail
              ? `${detail.project_name} (${detail.country}) · ${detail.buyer_name}`
              : '加载中...'}
          </SheetDescription>
        </SheetHeader>

        {loading || !detail ? (
          <div className={styles.drawerBody} role="status" aria-busy="true">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className={styles.drawerBody}>
            <div className={styles.drawerSurface} data-warm-panel="true">
              <div className={styles.slaBar}>
                <span
                  className={styles.statusPill}
                  data-tone={STATUS_TONE[detail.status]}
                >
                  {(() => {
                    const Icon = STATUS_ICON[detail.status]
                    return <Icon size={11} aria-hidden="true" />
                  })()}
                  {STATUS_LABEL[detail.status]}
                </span>
                {!isClosed && nextStatus ? (
                  <AlertDialog
                    open={pendingStatus === nextStatus}
                    onOpenChange={(nextOpen) => !nextOpen && setPendingStatus(null)}
                  >
                    <AlertDialogTrigger asChild>
                      <WarmButton
                        variant="secondary"
                        onClick={() => setPendingStatus(nextStatus)}
                        disabled={submitting}
                      >
                        {NEXT_STATUS_LABEL[detail.status]}
                      </WarmButton>
                    </AlertDialogTrigger>
                    <AlertDialogContent className={styles.dialog}>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确认状态流转</AlertDialogTitle>
                        <AlertDialogDescription>
                          将客诉 #{detail.id} 状态从「{STATUS_LABEL[detail.status]}」流转到「
                          {STATUS_LABEL[nextStatus]}」。此操作不可撤销。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                          <WarmButton variant="quiet" disabled={submitting}>
                            取消
                          </WarmButton>
                        </AlertDialogCancel>
                        <AlertDialogAction asChild>
                          <WarmButton
                            variant="primary"
                            onClick={() => void submitStatusChange(nextStatus)}
                            disabled={submitting}
                          >
                            {submitting ? <Loader2 size={12} className="animate-spin" /> : null}
                            确认流转
                          </WarmButton>
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
            </div>

            <div className={styles.drawerSection}>
              <div className={styles.drawerSurface}>
                <div className={styles.slaBar}>
                  <Clock size={13} aria-hidden="true" />
                  <span className={styles.orderLabel}>SLA 截止</span>
                  <span className={styles.drawerMeta}>
                    {formatDate(detail.sla.reply_deadline)}
                  </span>
                  {detail.sla.expires_soon && !isClosed ? (
                    <span className={styles.slaWarning}>
                      <AlertTriangle size={11} aria-hidden="true" /> 临期
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <section className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>
                <MessageSquare size={13} aria-hidden="true" />
                消息原文
              </div>
              <div className={`${styles.drawerSurface} ${styles.drawerMessage}`}>
                {detail.message_body}
              </div>
              <div className={styles.drawerMetaRow}>
                <span>买家: {detail.buyer_name}</span>
                <span>·</span>
                <span>{formatIsoDate(detail.message_date)}</span>
                <span>·</span>
                <span>{detail.subject}</span>
              </div>
            </section>

            <section className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>
                <Pencil size={13} aria-hidden="true" />
                Agent 摘要
              </div>
              <div className={styles.drawerSurface}>{detail.triage.summary_zh}</div>
            </section>

            {detail.has_order && detail.order ? (
              <section className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>
                  <ShoppingBag size={13} aria-hidden="true" />
                  订单信息
                </div>
                <div className={`${styles.drawerSurface} ${styles.orderGrid}`}>
                  <div className={styles.orderWide}>
                    <span className={styles.drawerMeta}>{detail.order.order_id}</span>
                    <button
                      type="button"
                      className={styles.copyButton}
                      onClick={() => handleCopyOrder(detail.order!.order_id)}
                      aria-label={`复制订单号 ${detail.order.order_id}`}
                    >
                      <ClipboardCopy size={11} aria-hidden="true" />
                    </button>
                  </div>
                  <div>
                    <span className={styles.orderLabel}>ASIN: </span>
                    <span>{detail.order.asin}</span>
                  </div>
                  <div>
                    <span className={styles.orderLabel}>数量: </span>
                    <span>{detail.order.qty}</span>
                  </div>
                  <div className={styles.orderWide}>
                    <span className={styles.orderLabel}>商品: </span>
                    <span>{detail.order.product_title}</span>
                  </div>
                  <div>
                    <span className={styles.orderLabel}>购买: </span>
                    <span>{formatIsoDate(detail.order.purchased_at)}</span>
                  </div>
                  <div>
                    <span className={styles.orderLabel}>发货: </span>
                    <span>{formatIsoDate(detail.order.shipped_at)}</span>
                  </div>
                  <div className={styles.orderWide}>
                    <span className={styles.orderLabel}>签收: </span>
                    <span>{formatIsoDate(detail.order.delivered_at)}</span>
                  </div>
                </div>
              </section>
            ) : null}

            <section className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>
                <Clock size={13} aria-hidden="true" />
                状态历史
              </div>
              <ol className={styles.history}>
                {[...detail.status_history].reverse().map((history, index) => (
                  <li key={index} className={styles.historyItem}>
                    <div className={styles.historyLabel}>
                      {history.from ? `${STATUS_LABEL[history.from]} → ` : ''}
                      <strong>{STATUS_LABEL[history.to]}</strong>
                    </div>
                    <div className={styles.historyMeta}>
                      {formatDate(history.at)} · {history.by}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className={styles.drawerSection}>
              <label className={styles.drawerSectionTitle} htmlFor="complaint-handler-note">
                <Pencil size={13} aria-hidden="true" />
                处理备注
              </label>
              <textarea
                id="complaint-handler-note"
                className={`${styles.drawerSurface} ${styles.noteInput}`}
                value={handlerNote}
                onChange={(event) => setHandlerNote(event.target.value)}
                placeholder="内部备注，仅团队可见"
                disabled={isClosed}
              />
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

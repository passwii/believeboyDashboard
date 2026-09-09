'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  ExternalLink,
  Loader2,
  MailWarning,
  MessageSquare,
  Package,
  Pencil,
  ShoppingBag,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
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
import { useNotifications } from '@/components/notifications'
import {
  type ComplaintDetail,
  type ComplaintStatus,
  type ComplaintStatusChangePayload,
  changeComplaintStatus,
  fetchComplaintDetail,
} from '@/lib/complaint-api'

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

const STATUS_BADGE: Record<ComplaintStatus, 'outline' | 'warning' | 'info' | 'success' | 'secondary'> = {
  pending: 'outline',
  drafted: 'warning',
  replied: 'info',
  resolved: 'success',
  closed_no_response: 'secondary',
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
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
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
      notify({ type: 'error', title: '加载失败', message: `加载详情失败: ${(err as Error).message}` })
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
      navigator.clipboard.writeText(orderId).then(() => {
        notify({ type: 'success', title: '已复制', message: `已复制订单号 ${orderId}` })
      }).catch(() => {
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
        notify({ type: 'success', title: '状态已更新', message: `状态已更新为「${STATUS_LABEL[status]}」` })
        onStatusChanged()
        onClose()
      } catch (err) {
        notify({ type: 'error', title: '更新失败', message: `状态更新失败: ${(err as Error).message}` })
      } finally {
        setSubmitting(false)
        setPendingStatus(null)
      }
    },
    [detail, handlerNote, projectNameById, notify, onStatusChanged, onClose]
  )

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  const isClosed = detail?.status === 'resolved' || detail?.status === 'closed_no_response'
  const nextStatus = detail?.status ? NEXT_STATUS[detail.status] : null

  return (
    <Sheet open={open} onOpenChange={(v) => !v && handleClose()}>
      <SheetContent side="right" className="w-full max-w-xl overflow-y-auto">
        <SheetHeader className="space-y-1">
          <SheetClose className="absolute right-4 top-4">
            <X size={16} />
          </SheetClose>
          <SheetTitle className="flex items-center gap-2 pr-8">
            <ShieldCheck size={18} />
            客诉详情
            {detail && (
              <span className="font-mono text-xs text-term-muted">#{detail.id}</span>
            )}
          </SheetTitle>
          <SheetDescription>
            {detail ? `${detail.project_name} (${detail.country}) · ${detail.buyer_name}` : '加载中...'}
          </SheetDescription>
        </SheetHeader>

        {loading || !detail ? (
          <div className="mt-6 space-y-4">
            <Skeleton className="h-32 w-full rounded-none" />
            <Skeleton className="h-24 w-full rounded-none" />
            <Skeleton className="h-16 w-full rounded-none" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* 状态 + 操作 */}
            <div className="flex items-center justify-between border border-term-border bg-term-raised px-3 py-2">
              <span className={`inline-flex items-center gap-1.5 rounded-none border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[detail.status] === 'outline' ? 'border-term-border bg-term-panel text-term-text' : STATUS_BADGE[detail.status] === 'warning' ? 'border-term-warn/20 bg-term-warn/10 text-term-warn' : STATUS_BADGE[detail.status] === 'info' ? 'border-term-accent/20 bg-term-accent/10 text-term-accent' : STATUS_BADGE[detail.status] === 'success' ? 'border-term-pos/20 bg-term-pos/10 text-term-pos' : 'border-term-border bg-term-raised text-term-muted'}`}>
                {(() => {
                  const Icon = STATUS_ICON[detail.status]
                  return <Icon size={10} />
                })()}
                {STATUS_LABEL[detail.status]}
              </span>
              {!isClosed && nextStatus && (
                <AlertDialog open={pendingStatus === nextStatus} onOpenChange={(v) => !v && setPendingStatus(null)}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="term"
                      size="sm"
                      onClick={() => setPendingStatus(nextStatus)}
                      disabled={submitting}
                    >
                      {NEXT_STATUS_LABEL[detail.status]}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="rounded-none border-term-border bg-term-panel">
                    <AlertDialogHeader>
                      <AlertDialogTitle>确认状态流转</AlertDialogTitle>
                      <AlertDialogDescription>
                        将客诉 #{detail.id} 状态从「{STATUS_LABEL[detail.status]}」
                        流转到「{STATUS_LABEL[nextStatus]}」。此操作不可撤销。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel asChild>
                        <Button variant="ghost" size="sm" disabled={submitting}>
                          取消
                        </Button>
                      </AlertDialogCancel>
                      <AlertDialogAction asChild>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void submitStatusChange(nextStatus)}
                          disabled={submitting}
                        >
                          {submitting && <Loader2 size={12} className="animate-spin" />}
                          确认流转
                        </Button>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>

            {/* SLA */}
            <div className="flex items-center gap-2 border border-term-border bg-term-panel px-3 py-2 text-xs">
              <Clock size={12} className="text-term-muted" />
              <span className="text-term-muted">SLA 截止</span>
              <span className="font-mono text-term-text">{formatDate(detail.sla.reply_deadline)}</span>
              {detail.sla.expires_soon && !isClosed && (
                <span className="ml-auto inline-flex items-center gap-1 text-term-warn">
                  <AlertTriangle size={10} />
                  临期
                </span>
              )}
            </div>

            {/* 消息原文 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-term-muted">
                <MessageSquare size={12} />
                消息原文
              </div>
              <div className="border border-term-border bg-term-bg px-3 py-2 font-mono text-xs leading-5 text-term-text whitespace-pre-wrap">
                {detail.message_body}
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-term-muted">
                <span>买家: {detail.buyer_name}</span>
                <span>·</span>
                <span>{formatIsoDate(detail.message_date)}</span>
                <span>·</span>
                <span className="truncate">{detail.subject}</span>
              </div>
            </div>

            {/* Agent 摘要 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-term-muted">
                <Pencil size={12} />
                Agent 摘要
              </div>
              <div className="border border-term-border bg-term-raised px-3 py-2 text-sm leading-5 text-term-text">
                {detail.triage.summary_zh}
              </div>
            </div>

            {/* 订单信息 */}
            {detail.has_order && detail.order && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-term-muted">
                  <ShoppingBag size={12} />
                  订单信息
                </div>
                <div className="grid grid-cols-2 gap-2 border border-term-border bg-term-panel px-3 py-2 text-xs">
                  <div className="col-span-2 flex items-center gap-1">
                    <span className="font-mono text-term-text">{detail.order.order_id}</span>
                    <button
                      type="button"
                      className="text-term-muted hover:text-term-text"
                      onClick={() => handleCopyOrder(detail.order!.order_id)}
                      title="复制订单号"
                    >
                      <ClipboardCopy size={10} />
                    </button>
                  </div>
                  <div>
                    <span className="text-term-muted">ASIN: </span>
                    <span className="font-mono text-term-text">{detail.order.asin}</span>
                  </div>
                  <div>
                    <span className="text-term-muted">数量: </span>
                    <span className="text-term-text">{detail.order.qty}</span>
                  </div>
                  <div className="col-span-2 truncate">
                    <span className="text-term-muted">商品: </span>
                    <span className="text-term-text">{detail.order.product_title}</span>
                  </div>
                  <div>
                    <span className="text-term-muted">购买: </span>
                    <span className="text-term-text">{formatIsoDate(detail.order.purchased_at)}</span>
                  </div>
                  <div>
                    <span className="text-term-muted">发货: </span>
                    <span className="text-term-text">{formatIsoDate(detail.order.shipped_at)}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-term-muted">签收: </span>
                    <span className="text-term-text">{formatIsoDate(detail.order.delivered_at)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 状态历史 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-term-muted">
                <Clock size={12} />
                状态历史
              </div>
              <ol className="relative space-y-0 border-l border-term-border pl-4">
                {[...detail.status_history].reverse().map((h, i) => (
                  <li key={i} className="relative pb-3 pl-2">
                    <span className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-term-border bg-term-panel" />
                    <div className="text-xs text-term-text">
                      {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}
                      <span className="font-semibold">{STATUS_LABEL[h.to]}</span>
                    </div>
                    <div className="text-[11px] text-term-muted">
                      {formatDate(h.at)} · {h.by}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* 处理备注 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-term-muted">
                <Pencil size={12} />
                处理备注
              </div>
              <Textarea
                value={handlerNote}
                onChange={(e) => setHandlerNote(e.target.value)}
                placeholder="内部备注，仅团队可见"
                size="sm"
                disabled={isClosed}
              />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

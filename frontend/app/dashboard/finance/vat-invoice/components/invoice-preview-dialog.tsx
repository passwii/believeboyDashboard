'use client'

// 预览 Dialog：左侧 HTML iframe 渲染 PDF 缩略，右侧下载/签发归档按钮。

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Download, FileText, Loader2, Save } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { drawInvoice, downloadInvoice } from '../lib/invoice-pdf'
import { createInvoiceDraft, issueInvoice } from '../lib/vat-invoice-api'
import type { InvoiceForm, InvoiceSellerEntry } from '../types'

interface InvoicePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  seller: InvoiceSellerEntry
  form: InvoiceForm
  /** 选中 Seller 对应 vat_entity.id；无主体时 null（invoice_no 走 NA 兜底） */
  sellerEntityId: number | null
}

export function InvoicePreviewDialog({
  open,
  onOpenChange,
  seller,
  form,
  sellerEntityId,
}: InvoicePreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null)
  const [building, setBuilding] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const { notify } = useNotifications()
  const router = useRouter()

  // 每次 Dialog 打开（或 seller/form 变化）重新生成 PDF blob URL；
  // 关闭时释放旧 URL，避免内存泄漏。
  useEffect(() => {
    if (!open) return

    setBuilding(true)
    const id = setTimeout(() => {
      try {
        const doc = drawInvoice(seller, form)
        const blob = doc.output('blob')
        const url = URL.createObjectURL(blob)
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev) // 释放上一次
          return url
        })
        setPdfBlob(blob)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('PDF render failed', err)
      } finally {
        setBuilding(false)
      }
    }, 50)

    return () => {
      clearTimeout(id)
    }
  }, [open, seller, form])

  // 关闭时释放当前 PDF URL
  useEffect(() => {
    if (open) return
    if (!pdfUrl) return
    URL.revokeObjectURL(pdfUrl)
    setPdfUrl(null)
  }, [open, pdfUrl])

  const handleDownload = () => {
    try {
      downloadInvoice(seller, form)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('PDF download failed', err)
    }
  }

  // Blob → base64（去掉 data:...;base64, 前缀）
  const blobToBase64 = (b: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        const result = String(r.result ?? '')
        const idx = result.indexOf('base64,')
        resolve(idx >= 0 ? result.slice(idx + 'base64,'.length) : result)
      }
      r.onerror = () => reject(r.error)
      r.readAsDataURL(b)
    })

  const handleIssue = async () => {
    if (!pdfBlob) {
      notify({ type: 'error', title: '签发失败', message: 'PDF 尚未渲染完成' })
      return
    }
    if (form.project_id == null) {
      notify({ type: 'error', title: '签发失败', message: '未选择店铺' })
      return
    }
    setIssuing(true)
    try {
      const draft = await createInvoiceDraft({
        project_id: form.project_id,
        seller_entity_id: sellerEntityId,
        currency: form.currency,
        order_id: form.order_id,
        invoice_date: form.invoice_date,
        buyer: form.buyer,
        shipping_incl_vat: form.shipping_incl_vat,
        lines: form.line_items.map((li) => ({
          description: li.description,
          asin: li.asin,
          qty: li.qty,
          unit_price_incl_vat: li.unit_price_incl_vat,
          vat_rate: li.vat_rate,
        })),
        status: 'draft',
      })
      const b64 = await blobToBase64(pdfBlob)
      await issueInvoice(draft.id, b64, `${draft.invoice_no}.pdf`)
      notify({ type: 'success', title: '签发并归档成功', message: draft.invoice_no })
      onOpenChange(false)
      router.push('/dashboard/finance/vat-invoice?tab=history')
    } catch (err) {
      notify({ type: 'error', title: '签发失败', message: normalizeErrorMessage(err) })
    } finally {
      setIssuing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            发票预览
          </DialogTitle>
          <DialogDescription>
            确认无误后点击「签发并归档」保存到服务器（R2 存 PDF）。
            「下载 PDF」仅本地导出，不留底。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
          <div className="min-h-[480px] rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))]">
            {building ? (
              <div className="flex h-[480px] items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在渲染 PDF…
              </div>
            ) : pdfUrl ? (
              <iframe
                src={pdfUrl}
                title="Invoice PDF preview"
                className="h-[420px] w-full rounded-lg sm:h-[600px]"
              />
            ) : (
              <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
                预览不可用
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 md:w-48">
            <Button onClick={handleIssue} disabled={!pdfBlob || issuing}>
              {issuing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {issuing ? '签发中…' : '签发并归档'}
            </Button>
            <Button variant="outline" onClick={handleDownload} disabled={!pdfUrl}>
              <Download className="mr-1.5 h-4 w-4" />
              下载 PDF（本地）
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </div>

        <DialogFooter>
          <p className="text-xs text-muted-foreground">
            {seller.company_name || 'Seller'} · 订单 {form.order_id || '未填'} · {form.currency}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

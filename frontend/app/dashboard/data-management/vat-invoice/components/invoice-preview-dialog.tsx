"use client"

// 预览 Dialog：左侧 HTML iframe 渲染 PDF 缩略，右侧下载按钮。

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Download, FileText, Loader2 } from "lucide-react"
import { drawInvoice, downloadInvoice } from "../lib/invoice-pdf"
import type { InvoiceForm, InvoiceSellerEntry } from "../types"

interface InvoicePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  seller: InvoiceSellerEntry
  form: InvoiceForm
}

export function InvoicePreviewDialog({
  open,
  onOpenChange,
  seller,
  form,
}: InvoicePreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)

  // 每次 Dialog 打开时（或 seller/form 变化时）重新生成 PDF blob URL；
  // 关闭时释放旧 URL，避免内存泄漏。
  useEffect(() => {
    if (!open) return

    setBuilding(true)
    const id = setTimeout(() => {
      try {
        const doc = drawInvoice(seller, form)
        const blob = doc.output("blob")
        const url = URL.createObjectURL(blob)
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev) // 释放上一次
          return url
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("PDF render failed", err)
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
      console.error("PDF download failed", err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            发票预览
          </DialogTitle>
          <DialogDescription>
            确认无误后点击右侧「下载 PDF」。每次重新打开会基于当前表单重新渲染。
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
                className="h-[600px] w-full rounded-lg"
              />
            ) : (
              <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
                预览不可用
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 md:w-48">
            <Button onClick={handleDownload} disabled={!pdfUrl}>
              <Download className="mr-1.5 h-4 w-4" />
              下载 PDF
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </div>

        <DialogFooter>
          <p className="text-xs text-muted-foreground">
            {seller.company_name || "Seller"} · 订单 {form.order_id || "未填"} · {form.currency}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

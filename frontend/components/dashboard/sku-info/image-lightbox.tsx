'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface ImageLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  meta?: {
    sku?: string
    productName?: string | null
    uploadedAt?: string | null
    uploadedBy?: string | null
  }
}

export function ImageLightbox({ open, onOpenChange, src, alt, meta }: ImageLightboxProps) {
  const [zoomed, setZoomed] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 关闭时重置 zoomed 状态，避免下次打开还残留
        if (!next) setZoomed(false)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className={cn(
          // 覆盖 DialogContent 默认的 bg-background / border / shadow，
          // 让 DialogContent 自身透明，只承载布局，背景由 DialogOverlay 黑色遮罩负责
          'flex flex-col items-center gap-3 border-0 bg-transparent p-2 shadow-none sm:p-4 dark:bg-transparent',
          // 默认 max-w-lg；lightbox 用 max-w-3xl，zoomed 状态接近全屏
          zoomed ? '!max-w-[96vw]' : '!max-w-3xl'
        )}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>

        <div
          className={cn(
            'flex w-full items-center justify-center overflow-hidden rounded-md text-center',
            zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in'
          )}
          style={{ maxHeight: zoomed ? 'calc(100vh - 8rem)' : '85vh' }}
          onClick={(e) => {
            e.stopPropagation()
            setZoomed((z) => !z)
          }}
          title={zoomed ? '点击缩小' : '点击放大'}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="rounded-md transition-all duration-[var(--duration-fast)]"
            style={{
              maxHeight: zoomed ? 'calc(100vh - 8rem)' : '85vh',
              maxWidth: zoomed ? '96vw' : '100%',
              width: zoomed ? '96vw' : 'auto',
              height: 'auto',
              objectFit: 'contain',
            }}
          />
        </div>

        {meta && (
          <div className="rounded-md bg-black/60 px-4 py-2 text-sm text-white">
            {meta.sku && <span className="font-mono font-medium">{meta.sku}</span>}
            {meta.productName && <span className="ml-2 text-white/80">{meta.productName}</span>}
            {meta.uploadedAt && (
              <span className="ml-2 text-white/60">
                上传于 {new Date(meta.uploadedAt).toLocaleString('zh-CN')}
              </span>
            )}
            {meta.uploadedBy && <span className="ml-2 text-white/60">by {meta.uploadedBy}</span>}
          </div>
        )}

        <p
          className={cn(
            'text-xs text-white/60 transition-opacity',
            zoomed ? 'opacity-100' : 'opacity-0'
          )}
        >
          点击图片{zoomed ? '缩小' : '放大'}
        </p>
      </DialogContent>
    </Dialog>
  )
}

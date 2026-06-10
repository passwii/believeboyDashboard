'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

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

export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  meta,
}: ImageLightboxProps) {
  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, onOpenChange])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={() => onOpenChange(false)}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-4 top-4 h-9 w-9 rounded-full bg-white/10 text-white hover:bg-white/20"
        onClick={() => onOpenChange(false)}
        aria-label="关闭"
      >
        <X className="h-5 w-5" />
      </Button>

      <div
        className="flex max-h-[90vh] max-w-[90vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="max-h-[80vh] max-w-[90vw] rounded-md object-contain"
        />
        {meta && (
          <div className="rounded-md bg-black/60 px-4 py-2 text-sm text-white">
            {meta.sku && (
              <span className="font-mono font-medium">{meta.sku}</span>
            )}
            {meta.productName && (
              <span className="ml-2 text-white/80">{meta.productName}</span>
            )}
            {meta.uploadedAt && (
              <span className="ml-2 text-white/60">
                上传于 {new Date(meta.uploadedAt).toLocaleString('zh-CN')}
              </span>
            )}
            {meta.uploadedBy && (
              <span className="ml-2 text-white/60">by {meta.uploadedBy}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

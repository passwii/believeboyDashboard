'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/**
 * PortraitScreenshotDialog — 专为竖图（手机截图/仪表盘快照）设计的大图预览
 * - 图片用固定尺寸渲染，不依赖 fill 布局，避免 flex 父容器约束导致压缩
 * - 长图自动完整显示，宽度不超过对话框宽度，高度自动
 * - 支持 maxHeight 限制，避免超出视口
 * - 点击图片可二级放大：撑满 Dialog 宽度，垂直滚动查看
 */
interface PortraitScreenshotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string | null
  alt: string
  /** 图片区域最大高度，默认 85vh */
  maxHeight?: string
}

export function PortraitScreenshotDialog({
  open,
  onOpenChange,
  src,
  alt,
  maxHeight = '85vh',
}: PortraitScreenshotDialogProps) {
  const [zoomed, setZoomed] = React.useState(false)

  React.useEffect(() => {
    if (open) setZoomed(false)
  }, [open])

  // 空 src 时不渲染 <img>，避免触发 "An empty string was passed to the src attribute" 警告
  const hasImage = typeof src === 'string' && src.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex flex-col items-center p-4 transition-all duration-[var(--duration-fast)]',
          zoomed ? 'max-w-[96vw]' : 'max-w-2xl'
        )}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div
          className={cn(
            'w-full overflow-y-auto',
            zoomed ? 'cursor-zoom-out' : 'text-center cursor-zoom-in'
          )}
          style={{ maxHeight: zoomed ? undefined : maxHeight }}
          onClick={(e) => {
            if (!hasImage) return
            e.stopPropagation()
            setZoomed((z) => !z)
          }}
          title={zoomed ? '点击缩小' : hasImage ? '点击放大' : '暂无图片'}
        >
          {hasImage ? (
            <img
              src={src as string}
              alt={alt}
              className="rounded-md"
              style={{
                width: zoomed ? '100%' : 'auto',
                maxWidth: zoomed ? 'none' : '100%',
                height: 'auto',
                objectFit: 'contain',
                transition: 'width 300ms ease',
              }}
            />
          ) : (
            <div className="flex h-32 w-full items-center justify-center text-sm text-muted-foreground">
              暂无图片可预览
            </div>
          )}
        </div>
        <p
          className={cn(
            'text-xs text-muted-foreground mt-2 transition-opacity',
            zoomed ? 'opacity-100' : 'opacity-0'
          )}
        >
          点击图片缩小
        </p>
      </DialogContent>
    </Dialog>
  )
}

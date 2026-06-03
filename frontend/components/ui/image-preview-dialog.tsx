"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

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
  src: string
  alt: string
  /** 图片区域最大高度，默认 85vh */
  maxHeight?: string
}

export function PortraitScreenshotDialog({
  open,
  onOpenChange,
  src,
  alt,
  maxHeight = "85vh",
}: PortraitScreenshotDialogProps) {
  const [zoomed, setZoomed] = React.useState(false)

  React.useEffect(() => {
    if (open) setZoomed(false)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "flex flex-col items-center p-4 transition-all duration-300",
        zoomed ? "max-w-[96vw]" : "max-w-2xl",
      )}>
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div
          className={cn(
            "w-full overflow-y-auto",
            zoomed ? "cursor-zoom-out" : "text-center cursor-zoom-in",
          )}
          style={{ maxHeight: zoomed ? undefined : maxHeight }}
          onClick={(e) => {
            e.stopPropagation()
            setZoomed(z => !z)
          }}
          title={zoomed ? "点击缩小" : "点击放大"}
        >
          <img
            src={src}
            alt={alt}
            className="rounded-md"
            style={{
              width: zoomed ? "100%" : "auto",
              maxWidth: zoomed ? "none" : "100%",
              height: "auto",
              objectFit: "contain",
              transition: "width 300ms ease",
            }}
          />
        </div>
        <p className={cn("text-xs text-muted-foreground mt-2 transition-opacity", zoomed ? "opacity-100" : "opacity-0")}>
          点击图片缩小
        </p>
      </DialogContent>
    </Dialog>
  )
}

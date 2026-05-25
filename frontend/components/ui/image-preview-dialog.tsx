"use client"

import * as React from "react"
import Image from "next/image"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ImagePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  title?: string
  description?: string
  className?: string
  imageContainerClassName?: string
  children?: React.ReactNode
}

export function ImagePreviewDialog({
  open,
  onOpenChange,
  src,
  alt,
  title,
  description,
  className,
  imageContainerClassName = "relative aspect-video w-full overflow-hidden rounded-md border border-border/70 bg-[hsl(var(--surface-subtle))]",
  children,
}: ImagePreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        {title ? (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        ) : (
          <DialogTitle className="sr-only">{alt}</DialogTitle>
        )}
        {children}
        <div className={imageContainerClassName}>
          <Image src={src} alt={alt} fill className="object-contain" unoptimized />
        </div>
      </DialogContent>
    </Dialog>
  )
}

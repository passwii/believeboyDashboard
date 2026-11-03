'use client'

import { useState, type ComponentProps } from 'react'
import { Upload } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications/notifications-context'
import type { ProductCostItem } from '@/app/dashboard/operations/sku-info/page'

interface ImageUploadSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sku: ProductCostItem | null
  onSuccess: () => void
  portalContainer?: HTMLElement | null
  contentClassName?: string
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus']
}

const API_BASE = '/api/backend'

export function ImageUploadSheet({
  open,
  onOpenChange,
  sku,
  onSuccess,
  portalContainer,
  contentClassName,
  onCloseAutoFocus,
}: ImageUploadSheetProps) {
  const { notify } = useNotifications()
  const [uploading, setUploading] = useState(false)

  if (!sku) return null

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(`${API_BASE}/api/v1/sku-info/${sku.id}/product-image`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.detail || `上传失败 (${response.status})`)
      }

      notify({
        type: 'success',
        title: '上传成功',
        message: `SKU ${sku.sku} 的产品图已上传`,
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      notify({
        type: 'error',
        title: '上传失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setUploading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        portalContainer={portalContainer}
        onCloseAutoFocus={onCloseAutoFocus}
        className={['w-[480px] sm:max-w-[480px]', contentClassName].filter(Boolean).join(' ')}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            {sku.product_image_r2_key ? '替换产品图' : '上传产品图'}
          </SheetTitle>
          <SheetDescription>
            <span className="font-mono">{sku.sku}</span>
            {sku.product_name && <span className="ml-2">{sku.product_name}</span>}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          <UploadZone
            accept="image/jpeg,image/png,image/webp,image/gif"
            maxSize={10}
            onUpload={handleUpload}
            disabled={uploading}
            uploadingText="上传中..."
            showPreview={true}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            支持 JPG / PNG / WebP / GIF 格式，单文件不超过 10MB。 系统会自动生成 1920×1920 主图和
            320×320 缩略图。
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}

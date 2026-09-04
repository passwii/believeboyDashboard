'use client'

import { useState, useMemo, useCallback } from 'react'
import { ImageIcon, Pencil, Trash2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { useNotifications } from '@/components/notifications/notifications-context'
import { ImageUploadSheet } from './image-upload-sheet'
import { ImageLightbox } from './image-lightbox'
import type { ProductCostItem } from '@/app/dashboard/operations/sku-info/page'

const API_BASE = '/api/backend'

interface ImageTabContentProps {
  projectName: string
  skus: ProductCostItem[]
  loading: boolean
  onRefresh: () => void
}

export function ImageTabContent({ projectName, skus, loading, onRefresh }: ImageTabContentProps) {
  const { notify } = useNotifications()
  const [search, setSearch] = useState('')
  const [uploadSheetOpen, setUploadSheetOpen] = useState(false)
  const [editingSku, setEditingSku] = useState<ProductCostItem | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxSku, setLightboxSku] = useState<ProductCostItem | null>(null)

  const filteredSkus = useMemo(() => {
    if (!search) return skus
    const q = search.toLowerCase()
    return skus.filter(
      (s) =>
        s.sku.toLowerCase().includes(q) ||
        s.asin.toLowerCase().includes(q) ||
        (s.product_name && s.product_name.toLowerCase().includes(q))
    )
  }, [skus, search])

  const handleUploadClick = useCallback((sku: ProductCostItem) => {
    setEditingSku(sku)
    setUploadSheetOpen(true)
  }, [])

  const handleThumbnailClick = useCallback((sku: ProductCostItem) => {
    setLightboxSku(sku)
    setLightboxOpen(true)
  }, [])

  const handleDelete = useCallback(
    async (sku: ProductCostItem) => {
      if (!confirm(`确认删除 SKU ${sku.sku} 的产品图？此操作不可撤销。`)) {
        return
      }
      try {
        const response = await fetch(`${API_BASE}/api/v1/sku-info/${sku.id}/product-image`, {
          method: 'DELETE',
        })
        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          throw new Error(error.detail || `删除失败 (${response.status})`)
        }
        notify({
          type: 'success',
          title: '已删除',
          message: `SKU ${sku.sku} 的产品图已删除`,
        })
        onRefresh()
      } catch (err) {
        notify({
          type: 'error',
          title: '删除失败',
          message: err instanceof Error ? err.message : '未知错误',
        })
      }
    },
    [notify, onRefresh]
  )

  if (!projectName) {
    return (
      <DataTableCard>
        <DataTableCardBody>
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            请先在顶部选择项目
          </div>
        </DataTableCardBody>
      </DataTableCard>
    )
  }

  return (
    <>
      <DataTableCard className="flex flex-col">
        <DataTableCardHeader
          title="产品图片"
          description="为项目下每个 SKU 维护一张产品主图"
          action={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索 SKU / ASIN / 品名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-[280px] pl-9"
              />
            </div>
          }
        />
        <DataTableCardBody className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredSkus.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {search ? '没有匹配的 SKU' : '该项目下没有 SKU'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50 bg-[hsl(var(--surface-subtle))] text-left">
                    <th className="w-20 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      缩略图
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      SKU
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      ASIN
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      品名
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      上传时间
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      上传者
                    </th>
                    <th className="w-32 px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSkus.map((sku) => (
                    <tr
                      key={sku.id}
                      className="border-b border-border/30 transition-colors hover:bg-[hsl(var(--surface-subtle))]/50"
                    >
                      <td className="px-4 py-2">
                        {sku.product_image_thumbnail_r2_url ? (
                          <button
                            type="button"
                            onClick={() => handleThumbnailClick(sku)}
                            className="block h-12 w-12 overflow-hidden rounded border border-border/50 transition-opacity hover:opacity-80"
                            aria-label="查看大图"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={sku.product_image_thumbnail_r2_url}
                              alt={sku.sku}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleUploadClick(sku)}
                            className="flex h-12 w-12 items-center justify-center rounded border-2 border-dashed border-border/50 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                            aria-label="上传图片"
                          >
                            <ImageIcon className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-[13px] font-medium text-foreground">
                          {sku.sku}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">{sku.asin}</td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_name || '—'}
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_image_uploaded_at
                          ? new Date(sku.product_image_uploaded_at).toLocaleString('zh-CN')
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_image_uploaded_by || '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleUploadClick(sku)}
                            aria-label="上传/替换"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {sku.product_image_r2_key && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(sku)}
                              aria-label="删除"
                              className="text-term-neg hover:bg-term-neg/5 hover:text-term-neg"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataTableCardBody>
      </DataTableCard>

      <ImageUploadSheet
        open={uploadSheetOpen}
        onOpenChange={setUploadSheetOpen}
        sku={editingSku}
        onSuccess={onRefresh}
      />

      <ImageLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        src={lightboxSku?.product_image_r2_url || ''}
        alt={lightboxSku?.sku || ''}
        meta={
          lightboxSku
            ? {
                sku: lightboxSku.sku,
                productName: lightboxSku.product_name,
                uploadedAt: lightboxSku.product_image_uploaded_at,
                uploadedBy: lightboxSku.product_image_uploaded_by,
              }
            : undefined
        }
      />
    </>
  )
}

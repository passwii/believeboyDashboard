'use client'

import { useState } from 'react'
import { Link2, Link2Off, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { COUNTRY_OPTIONS } from '@/lib/country'
import { formatShopOption, type ShopOption } from '@/lib/review-tracking-shops'
import type { ExternalTarget } from '@/lib/review-tracking-api'

/**
 * 外部竞品管理（阶段 C，BLF-1377）。
 *
 * 口径（设计稿 §8.2）：
 *  - 外部 ASIN 只在评论追踪页登记，不进 SKU 信息；
 *  - 同一个 `marketplace + asin` 只有一套追踪数据，可关联多个店铺；
 *  - **移除关联是软删**：只置 `is_active=false`，历史保留；重新关联同一店铺会复活原记录
 *    并沿用历史，不重复创建追踪历史。UI 必须如实说明，不能提示「已删除历史」。
 *
 * 写操作仅管理员（后端 403），非管理员这里只读展示。
 */
export interface ExternalTargetsPanelProps {
  targets: ExternalTarget[]
  shopOptions: ShopOption[]
  shopOptionsLoading?: boolean
  isAdmin: boolean
  busy?: boolean
  onCreate: (payload: {
    marketplace: string
    asin: string
    shopId: number | null
    displayName: string | null
  }) => Promise<void>
  onLink: (targetId: number, shopId: number) => Promise<void>
  onUnlink: (targetId: number, linkId: number) => Promise<void>
  onError: (error: unknown) => void
}

function activeLinks(target: ExternalTarget) {
  return target.links.filter((link) => link.isActive)
}

export function ExternalTargetsPanel({
  targets,
  shopOptions,
  shopOptionsLoading = false,
  isAdmin,
  busy = false,
  onCreate,
  onLink,
  onUnlink,
  onError,
}: ExternalTargetsPanelProps) {
  const [marketplace, setMarketplace] = useState('US')
  const [asin, setAsin] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [shopId, setShopId] = useState<string>('')
  const [linkTarget, setLinkTarget] = useState<ExternalTarget | null>(null)
  const [linkShop, setLinkShop] = useState<string>('')

  const shopLabelById = new Map(
    shopOptions.map((option) => [option.id, formatShopOption(option)])
  )

  const submit = async () => {
    const trimmedAsin = asin.trim().toUpperCase()
    if (!trimmedAsin) return
    try {
      await onCreate({
        marketplace,
        asin: trimmedAsin,
        shopId: shopId ? Number(shopId) : null,
        displayName: displayName.trim() || null,
      })
      setAsin('')
      setDisplayName('')
      setShopId('')
    } catch (error) {
      onError(error)
    }
  }

  const submitLink = async () => {
    if (!linkTarget || !linkShop) return
    try {
      await onLink(linkTarget.id, Number(linkShop))
      setLinkTarget(null)
      setLinkShop('')
    } catch (error) {
      onError(error)
    }
  }

  return (
    <div className="space-y-4" data-testid="external-targets-panel">
      {isAdmin ? (
        <div className="space-y-2 border border-term-border bg-term-panel p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-term-muted">
            登记外部竞品 ASIN
          </p>
          <div className="grid gap-2 sm:grid-cols-[130px_1fr_1fr_auto]">
            <Select value={marketplace} onValueChange={setMarketplace}>
              <SelectTrigger className="h-9" aria-label="站点">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[60vh] overflow-y-auto">
                {COUNTRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-9"
              placeholder="ASIN（10 位字母数字）"
              value={asin}
              maxLength={10}
              aria-label="ASIN"
              onChange={(event) => setAsin(event.target.value.toUpperCase())}
            />
            <Input
              className="h-9"
              placeholder="展示名称（可选）"
              value={displayName}
              aria-label="展示名称"
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              className="h-9"
              disabled={busy || !asin.trim() || shopOptionsLoading}
              onClick={() => void submit()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              登记
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-term-muted">登记时可直接关联店铺</span>
            <Select value={shopId} onValueChange={setShopId}>
              <SelectTrigger className="h-8 w-[280px]" aria-label="关联店铺">
                <SelectValue placeholder={shopOptionsLoading ? '店铺加载中…' : '不关联'} />
              </SelectTrigger>
              <SelectContent className="max-h-[60vh] overflow-y-auto">
                {shopOptions.map((option) => (
                  <SelectItem key={option.id} value={String(option.id)}>
                    {formatShopOption(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="font-mono text-[10px] text-term-faint">
            同一站点 + ASIN 只有一套追踪数据；可为同一 ASIN 关联多个店铺。
          </p>
        </div>
      ) : (
        <p className="font-mono text-[11px] text-term-muted">
          登记与店铺关联仅管理员可操作；你可以查看已有的外部竞品数据。
        </p>
      )}

      {targets.length === 0 ? (
        <EmptyState icon="database" message="还没有登记外部竞品" />
      ) : (
        <ul className="space-y-2">
          {targets.map((target) => {
            const links = activeLinks(target)
            return (
              <li
                key={target.id}
                className="border border-term-border bg-term-panel p-3"
                data-testid={`external-target-${target.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px] font-semibold text-term-text">
                        {target.displayName}
                      </span>
                      <Badge variant="outline" className="border-term-border text-term-muted">
                        {target.marketplace}
                      </Badge>
                      {target.isActive ? null : (
                        <Badge variant="outline" className="border-term-border text-term-muted">
                          已停用
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-term-faint">{target.asin}</p>
                  </div>
                  {isAdmin ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || shopOptionsLoading}
                      onClick={() => {
                        setLinkTarget(target)
                        setLinkShop('')
                      }}
                    >
                      <Link2 className="mr-1 h-3.5 w-3.5" />
                      关联店铺
                    </Button>
                  ) : null}
                </div>

                <div className="mt-2 space-y-1">
                  {links.length === 0 ? (
                    <p className="font-mono text-[10px] text-term-faint">尚未关联店铺</p>
                  ) : (
                    links.map((link) => (
                      <div
                        key={link.id}
                        className="flex items-center justify-between gap-2 border border-term-border/60 px-2 py-1"
                      >
                        <span className="truncate font-mono text-[11px] text-term-muted">
                          {shopLabelById.get(link.shopId) ?? `店铺 #${link.shopId}`}
                        </span>
                        {isAdmin ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              void onUnlink(target.id, link.id).catch(onError)
                            }}
                          >
                            <Link2Off className="mr-1 h-3.5 w-3.5" />
                            移除关联
                          </Button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="font-mono text-[10px] text-term-faint">
        移除店铺关联是软删：只标记失效、保留追踪历史；重新关联同一店铺会复活原记录并沿用历史，
        不会另建一套数据。
      </p>

      {isAdmin && linkTarget ? (
        <div className="space-y-2 border border-term-border-strong bg-term-raised p-3">
          <p className="font-mono text-[11px] text-term-text">
            为「{linkTarget.displayName}」关联店铺
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={linkShop} onValueChange={setLinkShop}>
              <SelectTrigger className="h-9 w-[280px]" aria-label="选择要关联的店铺">
                <SelectValue placeholder="选择店铺" />
              </SelectTrigger>
              <SelectContent className="max-h-[60vh] overflow-y-auto">
                {shopOptions.map((option) => (
                  <SelectItem key={option.id} value={String(option.id)}>
                    {formatShopOption(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              disabled={busy || !linkShop}
              onClick={() => void submitLink()}
            >
              关联
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setLinkTarget(null)
                setLinkShop('')
              }}
            >
              取消
            </Button>
          </div>
          <p className="font-mono text-[10px] text-term-faint">
            移除关联只是软删（保留历史）；重新关联同一店铺会复活原记录并沿用历史。
          </p>
        </div>
      ) : null}
    </div>
  )
}

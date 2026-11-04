'use client'

import { useState } from 'react'
import { Link2, Link2Off, Plus } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
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
import styles from '../review-tracking-warm.module.css'

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
  const [shopId, setShopId] = useState('')
  const [linkTarget, setLinkTarget] = useState<ExternalTarget | null>(null)
  const [linkShop, setLinkShop] = useState('')

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
    <div data-testid="external-targets-panel">
      <div className={`${styles.formSurface} ${styles.externalForm}`}>
        {isAdmin ? (
          <>
            <h3 className={styles.formTitle}>登记外部竞品 ASIN</h3>
            <div className={styles.formGrid}>
              <Select value={marketplace} onValueChange={setMarketplace}>
                <SelectTrigger className={styles.selectTrigger} aria-label="站点">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={styles.selectContent}>
                  {COUNTRY_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      className={styles.selectItem}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                className={styles.input}
                placeholder="ASIN（10 位字母数字）"
                value={asin}
                maxLength={10}
                aria-label="ASIN"
                onChange={(event) => setAsin(event.target.value.toUpperCase())}
              />
              <input
                className={styles.input}
                placeholder="展示名称（可选）"
                value={displayName}
                aria-label="展示名称"
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <WarmButton
                variant="primary"
                disabled={busy || !asin.trim() || shopOptionsLoading}
                onClick={() => void submit()}
              >
                <Plus size={14} aria-hidden="true" />
                登记
              </WarmButton>
            </div>
            <div className={styles.formRow}>
              <span className={styles.formLabel}>登记时可直接关联店铺</span>
              <Select value={shopId} onValueChange={setShopId}>
                <SelectTrigger
                  className={`${styles.selectTrigger} ${styles.linkSelect}`}
                  aria-label="关联店铺"
                >
                  <SelectValue placeholder={shopOptionsLoading ? '店铺加载中…' : '不关联'} />
                </SelectTrigger>
                <SelectContent className={styles.selectContent}>
                  {shopOptions.map((option) => (
                    <SelectItem
                      key={option.id}
                      value={String(option.id)}
                      className={styles.selectItem}
                    >
                      {formatShopOption(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className={styles.formNote}>
              同一站点 + ASIN 只有一套追踪数据；可为同一 ASIN 关联多个店铺。
            </p>
          </>
        ) : (
          <p className={styles.permissionNote}>
            登记与店铺关联仅管理员可操作；你可以查看已有的外部竞品数据。
          </p>
        )}
      </div>

      <div className={styles.externalContent}>
        {targets.length === 0 ? (
          <div className={styles.emptyPanel} role="status">
            还没有登记外部竞品
          </div>
        ) : (
          <ul className={styles.externalList}>
            {targets.map((target) => {
              const links = activeLinks(target)
              return (
                <li
                  key={target.id}
                  className={styles.externalItem}
                  data-testid={`external-target-${target.id}`}
                >
                  <div className={styles.externalTop}>
                    <div className={styles.externalIdentity}>
                      <span className={styles.externalName}>{target.displayName}</span>
                      <span className={styles.statusBadge} data-tone="muted">
                        {target.marketplace}
                      </span>
                      {target.isActive ? null : (
                        <span className={styles.statusBadge} data-tone="muted">
                          已停用
                        </span>
                      )}
                      <p className={styles.externalAsin}>{target.asin}</p>
                    </div>
                    {isAdmin ? (
                      <WarmButton
                        variant="secondary"
                        disabled={busy || shopOptionsLoading}
                        onClick={() => {
                          setLinkTarget(target)
                          setLinkShop('')
                        }}
                      >
                        <Link2 size={14} aria-hidden="true" />
                        关联店铺
                      </WarmButton>
                    ) : null}
                  </div>

                  <div className={styles.linkList}>
                    {links.length === 0 ? (
                      <p className={styles.emptyInline}>尚未关联店铺</p>
                    ) : (
                      links.map((link) => (
                        <div key={link.id} className={styles.linkRow}>
                          <span className={styles.linkName}>
                            {shopLabelById.get(link.shopId) ?? `店铺 #${link.shopId}`}
                          </span>
                          {isAdmin ? (
                            <WarmButton
                              variant="quiet"
                              disabled={busy}
                              onClick={() => {
                                void onUnlink(target.id, link.id).catch(onError)
                              }}
                            >
                              <Link2Off size={14} aria-hidden="true" />
                              移除关联
                            </WarmButton>
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

        <p className={`${styles.formNote} ${styles.formNoteSpaced}`}>
          移除店铺关联是软删：只标记失效、保留追踪历史；重新关联同一店铺会复活原记录并沿用历史，
          不会另建一套数据。
        </p>
      </div>

      {isAdmin && linkTarget ? (
        <div className={`${styles.formSurface} ${styles.externalLinkForm}`}>
          <h3 className={styles.formTitle}>为「{linkTarget.displayName}」关联店铺</h3>
          <div className={styles.formRow}>
            <Select value={linkShop} onValueChange={setLinkShop}>
              <SelectTrigger
                className={`${styles.selectTrigger} ${styles.linkSelect}`}
                aria-label="选择要关联的店铺"
              >
                <SelectValue placeholder="选择店铺" />
              </SelectTrigger>
              <SelectContent className={styles.selectContent}>
                {shopOptions.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={String(option.id)}
                    className={styles.selectItem}
                  >
                    {formatShopOption(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <WarmButton
              variant="primary"
              disabled={busy || !linkShop}
              onClick={() => void submitLink()}
            >
              关联
            </WarmButton>
            <WarmButton
              variant="secondary"
              onClick={() => {
                setLinkTarget(null)
                setLinkShop('')
              }}
            >
              取消
            </WarmButton>
          </div>
          <p className={styles.formNote}>
            移除关联只是软删（保留历史）；重新关联同一店铺会复活原记录并沿用历史。
          </p>
        </div>
      ) : null}
    </div>
  )
}

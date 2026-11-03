'use client'

import { useEffect, useRef, useState } from 'react'
import type { components } from '@/types/api-generated/api'
import { WarmBadge, WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import styles from '../shipping-plan-warm.module.css'

export type ShippingPlanSkuRow = components['schemas']['ShippingPlanSkuItem']
type DecimalValue = number | string
const SKU_PAGE_SIZE = 25

function number(value: DecimalValue | null | undefined, digits = 0) {
  const numeric = value == null ? null : Number(value)
  return numeric == null || !Number.isFinite(numeric)
    ? '—'
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numeric)
}

function qualityMeta(reasons: string[]): { label: string; tone: 'positive' | 'negative' } {
  if (!reasons.length) return { label: '可计算', tone: 'positive' }
  if (reasons.includes('inventory_snapshot_missing') || reasons.includes('sku_inventory_snapshot_missing')) {
    return { label: '缺少库存', tone: 'negative' }
  }
  if (reasons.includes('sales_baseline_missing')) return { label: '缺少销量', tone: 'negative' }
  if (reasons.includes('post_snapshot_inbound_before_forecast_start')) {
    return { label: '快照待更新', tone: 'negative' }
  }
  return { label: '待核实', tone: 'negative' }
}

export function SkuForecastTable({
  rows,
  selectedSku,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  rows: ShippingPlanSkuRow[]
  selectedSku: string
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (sku: string) => void
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const previousRowsRef = useRef(rows)
  const previousSelectedSkuRef = useRef(selectedSku)
  const pageCount = Math.ceil(rows.length / SKU_PAGE_SIZE)
  const currentPageIndex = Math.min(pageIndex, Math.max(0, pageCount - 1))
  const selectedRowIndex = rows.findIndex((row) => row.sku === selectedSku)
  const visibleRows = rows.slice(currentPageIndex * SKU_PAGE_SIZE, (currentPageIndex + 1) * SKU_PAGE_SIZE)

  useEffect(() => {
    const previousRows = previousRowsRef.current
    const previousSelectedIndex = previousRows.findIndex((row) => row.sku === previousSelectedSkuRef.current)
    const selectionChanged = previousSelectedSkuRef.current !== selectedSku
    const selectedWasVisible = previousSelectedIndex >= pageIndex * SKU_PAGE_SIZE &&
      previousSelectedIndex < (pageIndex + 1) * SKU_PAGE_SIZE
    let nextPageIndex = Math.min(pageIndex, Math.max(0, pageCount - 1))

    if (rows.length === 0) {
      nextPageIndex = 0
    } else if (selectionChanged) {
      nextPageIndex = selectedRowIndex >= 0 ? Math.floor(selectedRowIndex / SKU_PAGE_SIZE) : 0
    } else if (selectedWasVisible && selectedRowIndex >= 0) {
      nextPageIndex = Math.floor(selectedRowIndex / SKU_PAGE_SIZE)
    }

    previousRowsRef.current = rows
    previousSelectedSkuRef.current = selectedSku
    setPageIndex((current) => current === nextPageIndex ? current : nextPageIndex)
  }, [pageCount, pageIndex, rows, selectedRowIndex, selectedSku])

  return (
    <section className={`${styles.panel} ${styles.skuListPanel}`} data-testid="shipping-plan-sku-table" aria-labelledby="shipping-plan-sku-list-title">
      <header className={styles.panelHeader}>
        <div>
          <h2 id="shipping-plan-sku-list-title" className={styles.sectionTitle}>SKU 清单</h2>
          {!loading && !error && rows.length > 0 ? <span className={styles.skuCount}>{rows.length} 个 SKU</span> : null}
        </div>
      </header>
      {loading ? (
        <div className={styles.skuLoading} role="status" aria-busy="true">
          <span>{rows.length > 0 ? '正在更新 SKU 清单，暂时显示上次成功读取的完整清单。' : '正在读取 SKU 清单'}</span>
          <div className={styles.skuSkeletonList} aria-hidden="true">
            <i /><i /><i />
          </div>
        </div>
      ) : null}
      {!loading && error ? (
        <div className={styles.skuError} role="alert">
          <span>
            SKU 清单更新失败：{error}
            {rows.length > 0 ? ' 当前仍显示本项目和站点上次成功读取的完整清单。' : ''}
          </span>
          <WarmButton variant="secondary" onClick={onRetry}>重试 SKU 清单</WarmButton>
        </div>
      ) : null}
      {!loading && !error && rows.length === 0 ? (
        <div className={styles.skuEmpty} role="status">所选项目和站点暂无 SKU 预测数据。</div>
      ) : null}
      {rows.length > 0 ? (
        <div id="shipping-plan-sku-list" className={styles.skuList} role="group" aria-label="选择预测 SKU">
          {visibleRows.map((row) => {
            const selected = row.sku === selectedSku
            const quality = qualityMeta(row.data_quality ?? [])
            return (
              <button
                key={row.sku}
                type="button"
                className={`${styles.skuRow} ${selected ? styles.skuRowSelected : ''}`}
                aria-pressed={selected}
                onClick={() => onSelect(row.sku)}
              >
                <span className={styles.skuRowHeader}>
                  <span className={styles.skuName}>{row.sku}</span>
                  <WarmBadge tone={quality.tone}>{quality.label}</WarmBadge>
                </span>
                <span className={styles.skuDescription}>{row.product_name || row.asin || '—'}</span>
                <span className={styles.skuFactGrid}>
                  <span><span>可售库存</span><strong>{number(row.available_inventory)}</strong></span>
                  <span><span>基础 DMS</span><strong>{number(row.base_dms, 3)}</strong></span>
                </span>
                <span className={styles.skuScenarioValues}>
                  <span>确定上限 <strong>{number(row.confirmed_180d_sales_upper_bound)}</strong></span>
                  <span>计划上限 <strong>{number(row.planned_180d_sales_upper_bound)}</strong></span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
      {pageCount > 1 ? (
        <nav className={styles.skuPagination} aria-label="SKU 清单分页">
          <WarmButton
            className={styles.skuPaginationButton}
            variant="secondary"
            disabled={currentPageIndex === 0}
            aria-controls="shipping-plan-sku-list"
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          >
            上一页
          </WarmButton>
          <span className={styles.skuPageStatus} aria-live="polite">第 {currentPageIndex + 1} / {pageCount} 页</span>
          <WarmButton
            className={styles.skuPaginationButton}
            variant="secondary"
            disabled={currentPageIndex >= pageCount - 1}
            aria-controls="shipping-plan-sku-list"
            onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
          >
            下一页
          </WarmButton>
        </nav>
      ) : null}
    </section>
  )
}

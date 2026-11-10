'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { WarmCrmState, WarmCrmTableFrame } from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import {
  INTENT_PAGE_SIZE,
  INTENT_STATE_LABELS,
  type IntentCompany,
  type IntentCompanyPage,
  type IntentFollowup,
  type IntentListParams,
  type IntentState,
} from '@/lib/crm/intent/types'
import {
  apiErrorMessage,
  intentConflictFollowup,
  isIntentVersionConflict,
} from '@/lib/crm/intent/http-client'
import { useIntentClient } from '@/lib/crm/intent/provider'
import type { IntentQueryState } from '@/lib/crm/intent/use-intent-filters'

import { IntentCardGrid } from './intent-card-grid'
import { IntentPagination } from './intent-display'
import { IntentTable } from './intent-table'

import styles from '../intent-warm.module.css'

type IntentCompaniesTabProps = {
  state: IntentQueryState
  /** dataRev / followupRev / 手动刷新序号拼成的失效信号。 */
  revision: string
  /** scope 内完全没有公司（服务端 stats.total = 0）→ 区分真零数据与筛选无结果。 */
  zeroData: boolean
  canImport: boolean
  patch: (patch: Partial<IntentQueryState>) => void
  resetFilters: () => void
  onOpen: (id: number) => void
  onImport: () => void
  onRefreshRequested: () => void
  onStatsChanged: () => void
}

function hasFilters(state: IntentQueryState): boolean {
  return Boolean(
    state.level ||
      state.q.trim() ||
      state.category ||
      state.channel ||
      state.province ||
      state.city ||
      state.state ||
      state.withPhone ||
      state.dup ||
      state.due
  )
}

export function IntentCompaniesTab({
  state,
  revision,
  zeroData,
  canImport,
  patch,
  resetFilters,
  onOpen,
  onImport,
  onRefreshRequested,
  onStatsChanged,
}: IntentCompaniesTabProps) {
  const client = useIntentClient()
  const { notify } = useNotifications()
  const [result, setResult] = useState<{ signature: string; page: IntentCompanyPage } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ signature: string; message: string } | null>(null)
  const [retrySeq, setRetrySeq] = useState(0)
  const [items, setItems] = useState<IntentCompany[]>([])
  const [pendingIds, setPendingIds] = useState<Set<number>>(() => new Set())

  const listParams = useMemo<IntentListParams>(
    () => ({
      scope: state.scope,
      q: state.q.trim() || undefined,
      level: state.level ?? undefined,
      category: state.category ?? undefined,
      channel: state.channel ?? undefined,
      province: state.province ?? undefined,
      city: state.city ?? undefined,
      state: state.state ?? undefined,
      withPhone: state.withPhone || undefined,
      dup: state.dup || undefined,
      due: state.due || undefined,
      sort: state.sort,
      page: state.page,
      pageSize: INTENT_PAGE_SIZE,
    }),
    [state]
  )

  // 查询签名只在筛选 / 重试变化时失效（保留旧列表到新数据到达）；
  // revision（轮询 rev / 手动刷新）只触发后台重取，不隐藏当前内容。
  const querySignature = useMemo(
    () => JSON.stringify([listParams, retrySeq]),
    [listParams, retrySeq]
  )
  const fetchSignature = useMemo(
    () => JSON.stringify([querySignature, revision]),
    [querySignature, revision]
  )

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    client
      .listCompanies(listParams, { signal: controller.signal })
      .then((page) => {
        if (cancelled) return
        setResult({ signature: querySignature, page })
        setItems(page.items)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError({
          signature: querySignature,
          message: apiErrorMessage(reason, '加载意向客户失败'),
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, listParams, querySignature, fetchSignature])

  const page = result?.signature === querySignature ? result.page : null
  const errorMessage = error?.signature === querySignature ? error.message : null
  const isLoading = loading || (result?.signature !== querySignature && !errorMessage)
  const visibleItems = page ? items : []
  const total = page?.total ?? 0
  const activeFilters = hasFilters(state)

  const updateFollowup = useCallback((companyId: number, followup: IntentFollowup) => {
    setItems((current) =>
      current.map((company) =>
        company.id === companyId ? { ...company, followup } : company
      )
    )
  }, [])

  const handleStateChange = useCallback(
    async (company: IntentCompany, nextState: IntentState) => {
      const prev = company.followup
      if (nextState === prev.state) return
      const lastContactAt = new Date().toISOString()
      const optimistic: IntentFollowup = {
        ...prev,
        state: nextState,
        stateLabel: INTENT_STATE_LABELS[nextState],
        lastContactAt,
      }
      updateFollowup(company.id, optimistic)
      setPendingIds((current) => {
        const next = new Set(current)
        next.add(company.id)
        return next
      })
      try {
        const updated = await client.updateFollowup(
          company.id,
          { state: nextState, lastContactAt },
          prev.version
        )
        updateFollowup(company.id, updated)
        notify({
          type: 'success',
          title: '跟进状态已更新',
          message: `${company.name} · ${updated.stateLabel}`,
        })
        onStatsChanged()
      } catch (reason) {
        if (isIntentVersionConflict(reason)) {
          const current = intentConflictFollowup(reason)
          if (current) updateFollowup(company.id, current)
          notify({
            type: 'warning',
            title: '记录已被其他人更新',
            message: '已刷新为最新记录，请确认后再修改',
          })
          onRefreshRequested()
        } else {
          updateFollowup(company.id, prev)
          notify({
            type: 'error',
            title: '保存失败',
            message: apiErrorMessage(reason, '跟进状态保存失败'),
          })
        }
      } finally {
        setPendingIds((current) => {
          const next = new Set(current)
          next.delete(company.id)
          return next
        })
      }
    },
    [client, notify, onRefreshRequested, onStatsChanged, updateFollowup]
  )

  const footer = page ? (
    <div className={styles.listFooter}>
      <span className={styles.footerStatus} role="status">
        {isLoading ? '正在同步…' : null}
      </span>
      <IntentPagination
        onPage={(pageNumber) => patch({ page: pageNumber })}
        page={page.page}
        pageSize={INTENT_PAGE_SIZE}
        total={total}
      />
    </div>
  ) : null

  if (isLoading && !page) {
    return viewWrapper(state, footer, <WarmCrmState kind="loading" title="正在加载意向客户…" />)
  }

  if (errorMessage && !page) {
    return viewWrapper(
      state,
      footer,
      <WarmCrmState
        action={<WarmButton onClick={() => setRetrySeq((value) => value + 1)}>重试</WarmButton>}
        detail={errorMessage}
        kind="error"
        title="意向客户加载失败"
      />
    )
  }

  if (visibleItems.length === 0) {
    const empty = activeFilters ? (
      <WarmCrmState
        action={<WarmButton onClick={resetFilters}>清除全部筛选</WarmButton>}
        detail="换个关键词，或放宽级别 / 地区 / 状态筛选。"
        kind="empty"
        title="没有符合条件的企业"
      />
    ) : zeroData ? (
      <WarmCrmState
        action={
          canImport ? (
            <WarmButton variant="primary" onClick={onImport}>
              导入批次
            </WarmButton>
          ) : undefined
        }
        detail="由 AI 流水线或管理员导入首批批次后，这里会显示已筛企业。"
        kind="empty"
        title="还没有意向客户数据"
      />
    ) : (
      <WarmCrmState kind="empty" title="当前范围暂无意向客户" />
    )
    return viewWrapper(state, footer, empty)
  }

  if (state.view === 'card') {
    return viewWrapper(
      state,
      footer,
      <IntentCardGrid companies={visibleItems} group={state.group} onOpen={onOpen} />
    )
  }

  return (
    <WarmCrmTableFrame footer={footer}>
      <IntentTable
        companies={visibleItems}
        onOpen={onOpen}
        onStateChange={(company, nextState) => void handleStateChange(company, nextState)}
        pendingIds={pendingIds}
      />
    </WarmCrmTableFrame>
  )
}

function viewWrapper(
  state: IntentQueryState,
  footer: ReactNode,
  content: ReactNode
) {
  return (
    <div className={styles.listColumn}>
      <div className={styles.listScroll}>{content}</div>
      <div className={styles.listFooterBar}>{footer}</div>
    </div>
  )
}
export default IntentCompaniesTab

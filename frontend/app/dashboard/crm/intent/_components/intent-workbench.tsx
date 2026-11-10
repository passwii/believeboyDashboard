'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Download, RefreshCw, Upload } from 'lucide-react'

import {
  WarmCrmPage,
  WarmCrmState,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton, WarmSegmentedControl } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { downloadBlob } from '@/lib/download-blob'
import type { IntentClient } from '@/lib/crm/intent/client'
import { HttpIntentClient, apiErrorMessage } from '@/lib/crm/intent/http-client'
import { IntentClientProvider, useIntentClient } from '@/lib/crm/intent/provider'
import {
  INTENT_SCOPE_LABELS,
  INTENT_SCOPE_ORDER,
  INTENT_TAB_LABELS,
  INTENT_TAB_ORDER,
  INTENT_VIEW_LABELS,
  INTENT_VIEW_ORDER,
  type IntentExportParams,
  type IntentImportResult,
  type IntentMeta,
  type IntentView,
} from '@/lib/crm/intent/types'
import {
  formatDateTime,
  formatMonthDayTime,
  todayDateStamp,
} from '@/lib/crm/intent/format'
import { useIntentFilters } from '@/lib/crm/intent/use-intent-filters'
import { useIntentPolling } from '@/lib/crm/intent/use-intent-polling'

import { IntentBoardTab } from './intent-board-tab'
import { IntentCompaniesTab } from './intent-companies-tab'
import { IntentFilterBar } from './intent-filter-bar'
import { ImportBatchDialog } from './import-batch-dialog'
import { IntentMetrics } from './intent-metrics'
import { IntentPoolTab } from './intent-pool-tab'
import { IntentRecordDrawer } from './intent-record-drawer'

import styles from '../intent-warm.module.css'

export type IntentWorkbenchProps = {
  /** 测试注入 fake client；生产默认 HttpIntentClient。 */
  client?: IntentClient
}

export default function IntentWorkbench({ client }: IntentWorkbenchProps) {
  const resolvedClient = useMemo(() => client ?? new HttpIntentClient(), [client])
  return (
    <IntentClientProvider client={resolvedClient}>
      <IntentWorkbenchContent />
    </IntentClientProvider>
  )
}

type SyncState = 'loading' | 'ok' | 'syncing' | 'error'

function IntentWorkbenchContent() {
  const client = useIntentClient()
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const { state, patch, resetFilters, openRecord } = useIntentFilters()

  const [meta, setMeta] = useState<IntentMeta | null>(null)
  const metaRef = useRef<IntentMeta | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [pollError, setPollError] = useState(false)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [importOpen, setImportOpen] = useState(false)

  const isAdmin = (session?.user as { roleType?: string } | undefined)?.roleType === 'admin'

  const fetchMeta = useCallback(
    async (options?: { force?: boolean }) => {
      try {
        const current = metaRef.current
        const revs =
          options?.force || !current
            ? undefined
            : { dataRev: current.dataRev, followupRev: current.followupRev }
        const next = await client.getMeta(state.scope, revs)
        setPollError(false)
        if (next.changed === false && current) return
        metaRef.current = next
        setMeta(next)
        setMetaError(null)
      } catch (reason) {
        if (metaRef.current) {
          setPollError(true)
        } else {
          setMetaError(apiErrorMessage(reason, '加载意向客户失败'))
        }
      }
    },
    [client, state.scope]
  )

  useEffect(() => {
    metaRef.current = null
    setMeta(null)
    setMetaError(null)
    setPollError(false)
    void fetchMeta({ force: true })
  }, [fetchMeta])

  useIntentPolling({ onPoll: () => fetchMeta() })

  const handleRefresh = useCallback(async () => {
    setManualRefreshing(true)
    try {
      await fetchMeta({ force: true })
      setRefreshSeq((value) => value + 1)
    } finally {
      setManualRefreshing(false)
    }
  }, [fetchMeta])

  const handleMetaRetry = useCallback(() => {
    setMetaError(null)
    setPollError(false)
    void fetchMeta({ force: true })
  }, [fetchMeta])

  const handleStatsChanged = useCallback(() => {
    void fetchMeta({ force: true })
  }, [fetchMeta])

  const handleRefreshRequested = useCallback(() => {
    setRefreshSeq((value) => value + 1)
    void fetchMeta({ force: true })
  }, [fetchMeta])

  const exportParams = useMemo<IntentExportParams>(
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
    }),
    [state]
  )

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const { blob, filename } = await client.exportCsv(exportParams)
      const fallbackName = `客户雷达_意向客户_${
        meta?.batch?.batchDate ?? todayDateStamp()
      }.csv`
      downloadBlob(blob, filename ?? fallbackName)
      notify({ type: 'success', title: '已导出 CSV', message: filename ?? fallbackName })
    } catch (reason) {
      notify({
        type: 'error',
        title: '导出失败',
        message: apiErrorMessage(reason, '导出失败'),
      })
    } finally {
      setExporting(false)
    }
  }, [client, exportParams, meta, notify])

  const handleImported = useCallback(
    (result: IntentImportResult) => {
      setRefreshSeq((value) => value + 1)
      void fetchMeta({ force: true })
      if (result.rejectedCount > 0) {
        notify({
          type: 'warning',
          title: '批次已导入，部分行被拒绝',
          message: `拒绝 ${result.rejectedCount} 行，详见导入结果`,
        })
      }
    },
    [fetchMeta, notify]
  )

  const revision = `${meta?.dataRev ?? 0}:${meta?.followupRev ?? 0}:${refreshSeq}`
  const stats = meta?.stats ?? null

  const syncState: SyncState = metaError
    ? 'error'
    : manualRefreshing
      ? 'syncing'
      : pollError
        ? 'error'
        : meta
          ? 'ok'
          : 'loading'
  const syncText =
    syncState === 'error'
      ? '连接中断，正在重试'
      : syncState === 'syncing'
        ? '同步中…'
        : syncState === 'loading'
          ? '同步中…'
          : '同步正常'

  const tabOptions = INTENT_TAB_ORDER.map((tab) => {
    const count =
      tab === 'intent'
        ? stats?.total
        : tab === 'pool'
          ? stats?.poolTotal
          : stats?.contacted
    return {
      value: tab,
      label: count === undefined ? INTENT_TAB_LABELS[tab] : `${INTENT_TAB_LABELS[tab]} ${count}`,
    }
  })

  return (
    <WarmCrmPage className={styles.page} data-intent-workbench>
      <WarmCrmToolbar
        ariaLabel="意向客户工具栏"
        start={
          <>
            <WarmSegmentedControl
              ariaLabel="数据范围"
              options={INTENT_SCOPE_ORDER.map((scope) => ({
                value: scope,
                label: INTENT_SCOPE_LABELS[scope],
              }))}
              value={state.scope}
              onChange={(scope) => patch({ scope })}
            />
            <span className={styles.batchMeta} data-intent-batch-meta>
              批次 {meta?.batch?.batchDate ?? '—'} · 更新{' '}
              {formatDateTime(meta?.batch?.updatedAt ?? meta?.serverTime ?? null)}
            </span>
            <span className={styles.syncStatus} data-state={syncState} role="status">
              {syncText}
            </span>
          </>
        }
        end={
          <>
            <WarmButton
              loading={manualRefreshing}
              loadingLabel="正在刷新"
              onClick={() => void handleRefresh()}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </WarmButton>
            {isAdmin ? (
              <WarmButton onClick={() => setImportOpen(true)}>
                <Upload aria-hidden="true" />
                导入批次
              </WarmButton>
            ) : null}
            <WarmButton
              disabled={!meta || (stats?.total ?? 0) === 0}
              loading={exporting}
              loadingLabel="正在导出"
              onClick={() => void handleExport()}
            >
              <Download aria-hidden="true" />
              导出 CSV
            </WarmButton>
            {state.tab === 'intent' ? (
              <WarmSegmentedControl
                ariaLabel="列表视图"
                options={INTENT_VIEW_ORDER.map((view) => ({
                  value: view,
                  label: INTENT_VIEW_LABELS[view],
                }))}
                value={state.view}
                onChange={(view) => patch({ view: view as IntentView })}
              />
            ) : null}
          </>
        }
      />

      <IntentMetrics
        patch={patch}
        resetFilters={resetFilters}
        state={state}
        stats={stats}
      />

      {state.tab === 'intent' ? (
        <IntentFilterBar facets={meta?.facets ?? null} patch={patch} state={state} />
      ) : null}

      <div className={styles.tabRow}>
        <WarmSegmentedControl
          ariaLabel="视图页签"
          options={tabOptions}
          value={state.tab}
          onChange={(tab) => patch({ tab })}
        />
        {meta?.batch?.updatedAt ? (
          <span className={styles.tabUpdatedAt}>更新 {formatMonthDayTime(meta.batch.updatedAt)}</span>
        ) : null}
      </div>

      <div className={styles.content}>
        {metaError && !meta ? (
          <WarmCrmState
            action={<WarmButton onClick={handleMetaRetry}>重试</WarmButton>}
            detail={metaError}
            kind="error"
            title="意向客户加载失败"
          />
        ) : !meta ? (
          <WarmCrmState kind="loading" title="正在加载工作台…" />
        ) : state.tab === 'intent' ? (
          <IntentCompaniesTab
            canImport={isAdmin}
            onImport={() => setImportOpen(true)}
            onOpen={openRecord}
            onRefreshRequested={handleRefreshRequested}
            onStatsChanged={handleStatsChanged}
            patch={patch}
            resetFilters={resetFilters}
            revision={revision}
            state={state}
            zeroData={stats?.total === 0}
          />
        ) : state.tab === 'pool' ? (
          <IntentPoolTab
            page={state.poolPage}
            q={state.poolQ}
            revision={revision}
            onPage={(poolPage) => patch({ poolPage })}
            onSearch={(q) => patch({ poolQ: q, poolPage: 1 })}
          />
        ) : (
          <IntentBoardTab
            onFilterState={(intentState) => patch({ tab: 'intent', state: intentState, page: 1 })}
            onOpen={openRecord}
            revision={revision}
            scope={state.scope}
          />
        )}
      </div>

      <IntentRecordDrawer
        companyId={state.record}
        open={state.record !== null}
        onClose={() => openRecord(null)}
        onFollowupChanged={() => setRefreshSeq((value) => value + 1)}
        onRefreshRequested={handleRefreshRequested}
        onSelectCompany={(companyId) => openRecord(companyId)}
        onSelectPoolPhone={(phone) =>
          patch({ tab: 'pool', poolQ: phone, poolPage: 1, record: null })
        }
        onStatsChanged={handleStatsChanged}
      />

      {isAdmin ? (
        <ImportBatchDialog
          onImported={handleImported}
          onOpenChange={setImportOpen}
          open={importOpen}
        />
      ) : null}
    </WarmCrmPage>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
  X,
} from 'lucide-react'

import {
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
  WarmCrmToolbar,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useDebounce } from '@/hooks/use-debounce'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { FilterCondition, ListParams } from '@/lib/crm/api/crm-client'
import { CUSTOMER_SOURCE_LABELS } from '@/lib/crm/enums/customer.enum'
import { LEAD_INTENT_LABELS, LEAD_STATUS_LABELS } from '@/lib/crm/enums/lead.enum'
import { CUSTOMER_TYPE_OPTIONS, INTERESTED_SERVICE_OPTIONS } from '@/lib/crm/constants/options'
import { LEAD_FIELD_DEFS } from '@/lib/crm/field-defs/lead'
import { downloadCrmCsv } from '@/lib/crm/method/download-csv'
import type { Lead, LeadIntent, LeadStatus } from '@/lib/crm/types'
import { cn } from '@/lib/utils'

import styles from '@/app/dashboard/crm/leads/leads-warm.module.css'
import { CrmLeadForm } from './crm-lead-form'
import { CrmOverviewDrawer } from './crm-overview-drawer'
import { CrmTableHeaderRefresh } from './crm-table/header-refresh'
import type { FilterFieldDef } from './crm-table/types'
import { useCrmTable } from './crm-table/use-crm-table'

type LeadColumnKey =
  | 'name'
  | 'company'
  | 'status'
  | 'intent'
  | 'source'
  | 'ownerName'
  | 'expectedAmount'

type LeadColumn = {
  key: LeadColumnKey
  title: string
  sortable?: boolean
  numeric?: boolean
  render?: (lead: Lead) => ReactNode
}

const LEAD_STATUS_TONE: Record<LeadStatus, WarmCrmStatusTone> = {
  new: 'accent',
  contacting: 'neutral',
  qualified: 'neutral',
  converted: 'positive',
  discarded: 'negative',
}

const LEAD_INTENT_TONE: Record<LeadIntent, WarmCrmStatusTone> = {
  high: 'accent',
  medium: 'neutral',
  low: 'neutral',
}

const columns: LeadColumn[] = [
  { key: 'name', title: '联系人', sortable: true },
  { key: 'company', title: '公司' },
  {
    key: 'status',
    title: '状态',
    render: (lead) => (
      <WarmCrmStatusPill tone={LEAD_STATUS_TONE[lead.status]}>
        {LEAD_STATUS_LABELS[lead.status]}
      </WarmCrmStatusPill>
    ),
  },
  {
    key: 'intent',
    title: '意向',
    render: (lead) => (
      <WarmCrmStatusPill tone={LEAD_INTENT_TONE[lead.intent]}>
        {LEAD_INTENT_LABELS[lead.intent]}
      </WarmCrmStatusPill>
    ),
  },
  {
    key: 'source',
    title: '来源',
    render: (lead) => (
      <WarmCrmStatusPill>{CUSTOMER_SOURCE_LABELS[lead.source]}</WarmCrmStatusPill>
    ),
  },
  { key: 'ownerName', title: '负责人' },
  { key: 'expectedAmount', title: '预计金额', numeric: true },
]

function filterSelectValue(filters: FilterCondition[], field: string): string {
  const condition = filters.find(
    (item) => 'field' in item && item.field === field && item.op === 'eq'
  )
  if (!condition || !('value' in condition)) return ''
  return String(condition.value)
}

function SortIcon({
  active,
  order,
}: {
  active: boolean
  order?: 'asc' | 'desc'
}) {
  if (!active) {
    return <ArrowDownUp aria-hidden="true" className={styles.sortIcon} />
  }
  if (order === 'desc') {
    return <ArrowDown aria-hidden="true" className={styles.sortIcon} data-testid="sort-desc" />
  }
  return <ArrowUp aria-hidden="true" className={styles.sortIcon} data-testid="sort-asc" />
}

function LeadSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
}) {
  const [text, setText] = useState(value)
  const debounced = useDebounce(text, 300)

  useEffect(() => {
    if (debounced !== value) onChange(debounced)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only write after the debounced value changes
  }, [debounced])

  useEffect(() => {
    setText(value)
  }, [value])

  return (
    <div className={styles.searchWrap}>
      <Search aria-hidden="true" className={styles.searchIcon} />
      <input
        aria-label={placeholder}
        className={styles.searchInput}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        value={text}
      />
      {text ? (
        <button
          aria-label="清空搜索"
          className={styles.searchClear}
          onClick={() => setText('')}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

function LeadExportButton({
  scope,
  keyword,
}: {
  scope: 'mine' | 'all' | 'sea' | undefined
  keyword: string
}) {
  const { notify } = useNotifications()
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      await downloadCrmCsv('leads', { scope, keyword: keyword || undefined })
      notify({ type: 'success', title: '导出成功', message: 'CSV 已开始下载' })
    } catch (error) {
      notify({
        type: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <WarmButton
      className={styles.exportButton}
      data-testid="crm-export-csv"
      loading={exporting}
      onClick={handleExport}
    >
      {!exporting ? <Download aria-hidden="true" /> : null}
      {exporting ? '导出中…' : '导出 CSV'}
    </WarmButton>
  )
}

function PageJump({
  totalPages,
  onJump,
}: {
  totalPages: number
  onJump: (page: number) => void
}) {
  const [value, setValue] = useState('')

  const commit = () => {
    const page = Number.parseInt(value, 10)
    if (Number.isFinite(page) && page >= 1 && page <= totalPages) onJump(page)
    setValue('')
  }

  return (
    <span className={styles.pageJump}>
      <input
        aria-label="跳转到页码"
        className={styles.pageJumpInput}
        max={totalPages}
        min={1}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
        placeholder="页码"
        type="number"
        value={value}
      />
      <WarmButton
        className={styles.pageJumpButton}
        disabled={!value}
        onClick={commit}
      >
        跳
      </WarmButton>
    </span>
  )
}

export function CrmLeadTable() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const [active, setActive] = useState<Lead | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const leadFilterFields = useMemo<FilterFieldDef[]>(
    () => [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        field: 'status',
        options: Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'intent',
        label: '意向度',
        type: 'select',
        field: 'intent',
        options: Object.entries(LEAD_INTENT_LABELS).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'customerType',
        label: '对象类型',
        type: 'select',
        field: 'customerType',
        options: [...CUSTOMER_TYPE_OPTIONS],
      },
      {
        key: 'interestedService',
        label: '意向服务',
        type: 'select',
        field: 'interestedService',
        options: [...INTERESTED_SERVICE_OPTIONS],
      },
      {
        key: 'ownerId',
        label: '负责人',
        type: 'select',
        field: 'ownerId',
        options: users.map((user) => ({ value: user.id, label: user.name })),
      },
    ],
    [users]
  )

  const fetchPage = useCallback(
    async (params: ListParams) => {
      return client.listLeads({ ...params, scope: scope ?? params.scope })
    },
    [client, scope]
  )

  const table = useCrmTable<Lead>({
    queryKey: 'leads',
    fetchPage,
    defaultPageSize: 20,
  })

  const filtersKey = JSON.stringify(table.filters)
  const previousFiltersKey = useRef(filtersKey)
  useEffect(() => {
    if (previousFiltersKey.current !== filtersKey && table.page > 1) {
      table.setPage(1)
    }
    previousFiltersKey.current = filtersKey
    // eslint-disable-next-line react-hooks/exhaustive-deps -- compare filter contents only
  }, [filtersKey, table.page, table.setPage])

  const handleFilterChange = (field: string, value: string) => {
    const rest = table.filters.filter((item) => !('field' in item) || item.field !== field)
    const next: FilterCondition[] = value
      ? [...rest, { field, op: 'eq', value }]
      : rest
    table.setFiltersAndPage(next, 1)
  }

  const handleRowClick = useCallback((lead: Lead) => {
    setActive(lead)
    setDrawerOpen(true)
  }, [])

  const handleSave = useCallback(
    async (input: Record<string, unknown>) => {
      if (!active) return
      const updated = await client.updateLead(active.id, input as never)
      setActive(updated)
      setDrawerOpen(false)
    },
    [active, client]
  )

  const handleLeadFormSave = useCallback(
    async (input: import('@/lib/crm/types/lead').LeadInput) => {
      if (!active) return
      const updated = await client.updateLead(active.id, input)
      setActive(updated)
      setDrawerOpen(false)
    },
    [active, client]
  )

  const handleConvert = useCallback(async () => {
    if (!active) return
    await client.convertLead(active.id)
    notify({
      type: 'success',
      title: '已转化为客户',
      message: `线索「${active.name}」转为客户`,
    })
    setDrawerOpen(false)
  }, [active, client, notify])

  const initialLoading = table.loading && table.data === undefined
  const initialError = table.error && table.data === undefined
  const totalPages = Math.max(1, Math.ceil(table.total / table.pageSize))

  return (
    <div className={styles.tableRoot} data-warm-leads-table>
      <CrmTableHeaderRefresh loading={table.loading} refresh={table.refresh} />

      {table.error && table.data !== undefined ? (
        <div className={styles.errorBar} role="alert">
          <span>刷新失败：{table.error.message}</span>
          <WarmButton className={styles.retryButton} onClick={() => void table.refresh()}>
            重试
          </WarmButton>
        </div>
      ) : null}

      <WarmCrmToolbar
        ariaLabel="线索筛选"
        className={styles.toolbar}
        end={<LeadExportButton keyword={table.keyword} scope={scope} />}
        start={
          <>
            <LeadSearch
              onChange={table.setKeyword}
              placeholder="搜索联系人 / 公司…"
              value={table.keyword}
            />
            {leadFilterFields.map((field) => (
              <label className={styles.filterControl} key={field.key}>
                <span className={styles.srOnly}>{field.label}</span>
                <select
                  className={styles.filterSelect}
                  onChange={(event) =>
                    handleFilterChange(field.field ?? field.key, event.target.value)
                  }
                  value={filterSelectValue(table.filters, field.field ?? field.key)}
                >
                  <option value="">{field.label}：全部</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </>
        }
      />

      {initialLoading ? (
        <WarmCrmState kind="loading" title="表格加载中" />
      ) : initialError ? (
        <WarmCrmState
          action={<WarmButton onClick={() => void table.refresh()}>重试</WarmButton>}
          detail={table.error?.message}
          kind="error"
          title="加载失败"
        />
      ) : (table.data ?? []).length === 0 ? (
        <WarmCrmState kind="empty" title="暂无线索" />
      ) : (
        <WarmCrmTableFrame
          footer={
            table.total > 0 ? (
              <div className={styles.pagination}>
                <div className={styles.paginationMeta}>
                  <span>共 {table.total} 条</span>
                  <label className={styles.pageSize}>
                    每页
                    <select
                      aria-label="每页条数"
                      className={styles.pageSizeSelect}
                      onChange={(event) => table.setPageSize(Number(event.target.value))}
                      value={table.pageSize}
                    >
                      {[20, 50, 100].map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className={styles.pager}>
                  <WarmButton
                    aria-label="首页"
                    className={styles.pagerButton}
                    disabled={table.page <= 1}
                    onClick={() => table.setPage(1)}
                  >
                    <ChevronsLeft aria-hidden="true" />
                  </WarmButton>
                  <WarmButton
                    aria-label="上一页"
                    className={styles.pagerButton}
                    disabled={table.page <= 1}
                    onClick={() => table.setPage(table.page - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </WarmButton>
                  <span className={styles.pageStatus}>
                    第 {table.page} / {totalPages} 页
                  </span>
                  <WarmButton
                    aria-label="下一页"
                    className={styles.pagerButton}
                    disabled={table.page >= totalPages}
                    onClick={() => table.setPage(table.page + 1)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </WarmButton>
                  <WarmButton
                    aria-label="末页"
                    className={styles.pagerButton}
                    disabled={table.page >= totalPages}
                    onClick={() => table.setPage(totalPages)}
                  >
                    <ChevronsRight aria-hidden="true" />
                  </WarmButton>
                  {totalPages > 1 ? (
                    <PageJump onJump={table.setPage} totalPages={totalPages} />
                  ) : null}
                </div>
              </div>
            ) : undefined
          }
        >
          <WarmCrmTableScroller ariaLabel="线索表格" interactiveRows>
            <table className={styles.table}>
              <thead>
                <tr>
                  {columns.map((column) => {
                    const activeSort = table.sortBy === column.key
                    const ariaSort = activeSort
                      ? table.sortOrder === 'desc'
                        ? 'descending'
                        : 'ascending'
                      : column.sortable
                        ? 'none'
                        : undefined

                    return (
                      <th
                        aria-sort={ariaSort}
                        data-numeric={column.numeric ? '' : undefined}
                        key={column.key}
                        scope="col"
                      >
                        {column.sortable ? (
                          <button
                            className={styles.sortButton}
                            onClick={() => table.toggleSort(column.key)}
                            type="button"
                          >
                            {column.title}
                            <SortIcon active={activeSort} order={table.sortOrder} />
                          </button>
                        ) : (
                          column.title
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {(table.data ?? []).map((lead) => (
                  <tr key={lead.id} onClick={() => handleRowClick(lead)}>
                    {columns.map((column) => {
                      const value = lead[column.key]
                      return (
                        <td
                          className={cn(
                            column.numeric && styles.numericCell
                          )}
                          data-numeric={column.numeric ? '' : undefined}
                          key={column.key}
                        >
                          {column.render
                            ? column.render(lead)
                            : column.numeric && typeof value === 'number'
                              ? value.toLocaleString('zh-CN')
                              : value || '-'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </WarmCrmTableScroller>
        </WarmCrmTableFrame>
      )}

      {active ? (
        <CrmOverviewDrawer<Lead>
          actions={
            active.status !== 'converted' && active.status !== 'discarded' ? (
              <WarmButton onClick={handleConvert} variant="primary">
                转为客户
              </WarmButton>
            ) : undefined
          }
          createFollow={(input) => client.createFollow(input)}
          data={active}
          editForm={
            <CrmLeadForm
              initialValues={active}
              onSubmit={handleLeadFormSave}
              submitText="保存修改"
              users={users}
            />
          }
          entityId={active.id}
          entityType="lead"
          fields={LEAD_FIELD_DEFS}
          headerExtra={
            <WarmCrmStatusPill tone={LEAD_STATUS_TONE[active.status]}>
              {LEAD_STATUS_LABELS[active.status]}
            </WarmCrmStatusPill>
          }
          loadFollows={(entityType, entityId) => client.listFollows(entityType, entityId)}
          onOpenChange={setDrawerOpen}
          onSave={handleSave}
          open={drawerOpen}
          title={active.name}
          users={users}
        />
      ) : null}
    </div>
  )
}

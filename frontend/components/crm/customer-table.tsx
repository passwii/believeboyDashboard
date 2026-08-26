'use client'

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CrmTable } from './crm-table'
import type { CrmColumnDef, FilterFieldDef } from './crm-table/types'
import { CrmOverviewDrawer } from './crm-overview-drawer'
import { CUSTOMER_TYPE_OPTIONS, INTERESTED_SERVICE_OPTIONS } from '@/lib/crm/constants/options'
import { CrmExportButton } from './crm-export-button'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { Customer } from '@/lib/crm/types'
import {
  CUSTOMER_RATING_COLORS,
  CUSTOMER_RATING_LABELS,
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_STATUS_COLORS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'
import { daysSince } from '@/lib/crm/method/format'
import { cn } from '@/lib/utils'
import {
  CUSTOMER_RATING_TERM,
  CUSTOMER_STATUS_TERM,
  NEUTRAL_TERM,
} from '@/components/crm/term-shared'

const columns: CrmColumnDef<Customer>[] = [
  { key: 'name', title: '客户名', sortable: true },
  {
    key: 'rating',
    title: '等级',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_RATING_LABELS) as Array<keyof typeof CUSTOMER_RATING_LABELS>).map(
        (k) => [k, { label: CUSTOMER_RATING_LABELS[k], color: CUSTOMER_RATING_COLORS[k], tone: CUSTOMER_RATING_TERM[k] }]
      )
    ),
  },
  {
    key: 'status',
    title: '状态',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_STATUS_LABELS) as Array<keyof typeof CUSTOMER_STATUS_LABELS>).map(
        (k) => [k, { label: CUSTOMER_STATUS_LABELS[k], color: CUSTOMER_STATUS_COLORS[k], tone: CUSTOMER_STATUS_TERM[k] }]
      )
    ),
  },
  {
    key: 'source',
    title: '来源',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_SOURCE_LABELS) as Array<keyof typeof CUSTOMER_SOURCE_LABELS>).map(
        (k) => [k, { label: CUSTOMER_SOURCE_LABELS[k], color: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]', tone: NEUTRAL_TERM }]
      )
    ),
  },
  {
    key: 'categories',
    title: '产品类目',
    render: (value) => {
      const cats = (value ?? []) as Array<{ id: string; name: string }>
      if (cats.length === 0) return '-'
      const shown = cats.slice(0, 2)
      const rest = cats.length - shown.length
      return (
        <div className="flex flex-wrap items-center gap-1">
          {shown.map((c) => (
            <Badge key={c.id} variant="secondary" className="font-normal">
              {c.name}
            </Badge>
          ))}
          {rest > 0 && (
            <span className="text-xs text-muted-foreground">+{rest}</span>
          )}
        </div>
      )
    },
  },
  { key: 'ownerName', title: '负责人' },
  { key: 'contactName', title: '联系人' },
  { key: 'contactPhone', title: '联系电话' },
  {
    key: 'lastFollowAt',
    title: '最后跟进',
    sortable: true,
    format: 'date',
    render: (value) => {
      const v = value as string | undefined
      if (!v) return '-'
      const days = daysSince(v)
      const overdue = Number.isFinite(days) && days > 7
      return (
        <span className={cn(overdue ? 'text-term-neg' : '')}>
          <span className="tabular-nums">{new Date(v).toLocaleDateString('zh-CN')}</span>
          {overdue && <span className="ml-1 tabular-nums">· {days}天前</span>}
        </span>
      )
    },
  },
]

export function CrmCustomerTable() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''
  const [active, setActive] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [moving, setMoving] = useState(false)

  // 表头快捷筛选字段（field 用后端 filter_engine 白名单的驼峰名）。
  // 对象类型/意向服务暂无枚举常量，选项与后端字段语义保持一致。
  const customerFilterFields = useMemo<FilterFieldDef[]>(
    () => [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        field: 'status',
        options: Object.entries(CUSTOMER_STATUS_LABELS).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'rating',
        label: '等级',
        type: 'select',
        field: 'rating',
        options: Object.entries(CUSTOMER_RATING_LABELS).map(([value, label]) => ({ value, label })),
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
        options: users.map((u) => ({ value: u.id, label: u.name })),
      },
    ],
    [users]
  )

  const fetchPage = useCallback(
    async (params: Parameters<typeof client.listCustomers>[0]) => {
      return client.listCustomers({ ...params, scope: scope ?? params.scope })
    },
    [client, scope]
  )

  const handleRowClick = useCallback(async (row: Customer) => {
    setActive(row)
    setDrawerOpen(true)
  }, [])

  const handleSave = useCallback(
    async (input: Record<string, unknown>) => {
      if (!active) return
      const updated = await client.updateCustomer(active.id, input as never)
      setActive(updated)
      setDrawerOpen(false)
    },
    [active, client]
  )

  const handleBatchMoveToSea = useCallback(async () => {
    if (selectedIds.length === 0) return
    setMoving(true)
    try {
      await client.batchMoveToSea(selectedIds)
      notify({
        type: 'success',
        title: '已移入公海',
        message: `已释放 ${selectedIds.length} 个客户`,
      })
      setSelectedIds([])
      setRefreshKey((k) => k + 1)
    } finally {
      setMoving(false)
    }
  }, [selectedIds, client, notify])

  return (
    <>
      {/* BLF-837：工具行终端化（批量操作 + 导出），提示文案并入面包屑/空态 */}
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedIds.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleBatchMoveToSea}
              disabled={moving}
              data-testid="batch-move-to-sea"
              className="h-8 rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
            >
              {moving ? '处理中…' : `移入公海（${selectedIds.length}）`}
            </Button>
          )}
          <CrmExportButton entity="customers" scope={scope} keyword={keyword} />
        </div>
      </div>
      <CrmTable<Customer>
        queryKey="customers"
        fetchPage={fetchPage}
        columns={columns}
        filterFields={customerFilterFields}
        searchable
        searchPlaceholder="搜索客户名 / 简称…"
        rowKey="id"
        emptyText="暂无客户"
        defaultPageSize={20}
        onRowClick={handleRowClick}
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        refreshKey={refreshKey}
      />
      {active && (
        <CrmOverviewDrawer<Customer>
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          entityType="customer"
          entityId={active.id}
          data={active}
          fields={CUSTOMER_FIELD_DEFS}
          title={active.name}
          headerExtra={
            <Badge variant="secondary" className={CUSTOMER_STATUS_COLORS[active.status]}>
              {CUSTOMER_STATUS_LABELS[active.status]}
            </Badge>
          }
          users={users}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSave}
        />
      )}
    </>
  )
}

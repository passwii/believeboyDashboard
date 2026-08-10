'use client'

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
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

const columns: CrmColumnDef<Customer>[] = [
  { key: 'name', title: '客户名', sortable: true },
  {
    key: 'rating',
    title: '等级',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_RATING_LABELS) as Array<keyof typeof CUSTOMER_RATING_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_RATING_LABELS[k], color: CUSTOMER_RATING_COLORS[k] },
      ])
    ),
  },
  {
    key: 'status',
    title: '状态',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_STATUS_LABELS) as Array<keyof typeof CUSTOMER_STATUS_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_STATUS_LABELS[k], color: CUSTOMER_STATUS_COLORS[k] },
      ])
    ),
  },
  {
    key: 'source',
    title: '来源',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_SOURCE_LABELS) as Array<keyof typeof CUSTOMER_SOURCE_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_SOURCE_LABELS[k], color: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]' },
      ])
    ),
  },
  { key: 'contactName', title: '联系人' },
  { key: 'contactPhone', title: '联系电话' },
  {
    key: 'updatedAt',
    title: '进公海时长',
    sortable: true,
    render: (value) => {
      const v = value as string | undefined
      if (!v) return '-'
      const days = daysSince(v)
      return Number.isFinite(days) ? `${days} 天前` : '-'
    },
  },
]

export function CrmSeaTable() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''
  const [active, setActive] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // G2：领取成功后 +1 触发 CrmTable 主动刷新，被领取客户立即从公海消失
  const [refreshKey, setRefreshKey] = useState(0)

  // 公海快捷筛选：无负责人（公海客户均无主），其余与客户表一致。
  const seaFilterFields = useMemo<FilterFieldDef[]>(
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
        key: 'source',
        label: '来源',
        type: 'select',
        field: 'source',
        options: Object.entries(CUSTOMER_SOURCE_LABELS).map(([value, label]) => ({ value, label })),
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
    ],
    []
  )

  const fetchPage = useCallback(
    async (params: Parameters<typeof client.listCustomers>[0]) => {
      // 公海：固定 scope='sea'，忽略数据范围切换
      return client.listCustomers({ ...params, scope: 'sea' })
    },
    [client]
  )

  const handleRowClick = useCallback((row: Customer) => {
    setActive(row)
    setDrawerOpen(true)
  }, [])

  const handleClaim = useCallback(async () => {
    if (!active) return
    await client.claimFromSea(active.id)
    notify({ type: 'success', title: '已领取客户', message: active.name })
    setActive(null)
    setDrawerOpen(false)
    setRefreshKey((k) => k + 1)
  }, [active, client, notify])

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">公海客户 · 可筛选 / 搜索 / 导出，点击行领取</p>
        <CrmExportButton entity="customers" scope="sea" keyword={keyword} />
      </div>
      <CrmTable<Customer>
        queryKey="sea"
        fetchPage={fetchPage}
        columns={columns}
        filterFields={seaFilterFields}
        rowKey="id"
        emptyText="公海暂无客户"
        defaultPageSize={20}
        onRowClick={handleRowClick}
        searchable
        searchPlaceholder="搜索客户名 / 简称…"
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
          actions={
            <Button size="sm" onClick={handleClaim}>
              领取
            </Button>
          }
          headerExtra={
            <Badge variant="secondary" className={CUSTOMER_STATUS_COLORS[active.status]}>
              {CUSTOMER_STATUS_LABELS[active.status]}
            </Badge>
          }
          users={users}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={async () => {
            /* 公海只读，不保存 */
          }}
        />
      )}
    </>
  )
}

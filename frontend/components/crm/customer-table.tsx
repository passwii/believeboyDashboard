'use client'

import { useCallback, useState } from 'react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { Badge } from '@/components/ui/badge'
import { CrmTable } from './crm-table'
import type { CrmColumnDef } from './crm-table/types'
import { CrmOverviewDrawer } from './crm-overview-drawer'
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
      (Object.keys(CUSTOMER_RATING_LABELS) as Array<keyof typeof CUSTOMER_RATING_LABELS>).map(
        (k) => [k, { label: CUSTOMER_RATING_LABELS[k], color: CUSTOMER_RATING_COLORS[k] }]
      )
    ),
  },
  {
    key: 'status',
    title: '状态',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_STATUS_LABELS) as Array<keyof typeof CUSTOMER_STATUS_LABELS>).map(
        (k) => [k, { label: CUSTOMER_STATUS_LABELS[k], color: CUSTOMER_STATUS_COLORS[k] }]
      )
    ),
  },
  {
    key: 'source',
    title: '来源',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_SOURCE_LABELS) as Array<keyof typeof CUSTOMER_SOURCE_LABELS>).map(
        (k) => [k, { label: CUSTOMER_SOURCE_LABELS[k], color: 'bg-slate-100 text-slate-700' }]
      )
    ),
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
        <span className={overdue ? 'text-rose-600 dark:text-rose-400' : ''}>
          {new Date(v).toLocaleDateString('zh-CN')}
          {overdue && <span className="ml-1 text-xs">· {days}天前</span>}
        </span>
      )
    },
  },
]

export function CrmCustomerTable() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const [active, setActive] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

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

  return (
    <>
      <CrmTable<Customer>
        queryKey="customers"
        fetchPage={fetchPage}
        columns={columns}
        rowKey="id"
        emptyText="暂无客户"
        defaultPageSize={20}
        onRowClick={handleRowClick}
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
          users={[]}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSave}
        />
      )}
    </>
  )
}

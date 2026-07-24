'use client'

import { useCallback, useState } from 'react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CrmTable } from './crm-table'
import type { CrmColumnDef } from './crm-table/types'
import { CrmOverviewDrawer } from './crm-overview-drawer'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { Customer } from '@/lib/crm/types'
import {
  CUSTOMER_RATING_COLORS,
  CUSTOMER_RATING_LABELS,
  CUSTOMER_STATUS_COLORS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'

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
  { key: 'source', title: '来源' },
  { key: 'contactName', title: '联系人' },
  { key: 'contactPhone', title: '联系电话' },
]

export function CrmSeaTable() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const [active, setActive] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const fetchPage = useCallback(
    async (params: Parameters<typeof client.listCustomers>[0]) => {
      // 公海：固定 scope='sea'，忽略数据范围切换
      return client.listCustomers({ ...params, scope: 'sea' })
    },
    [client]
  )

  const handleRowClick = useCallback(async (row: Customer) => {
    setActive(row)
    setDrawerOpen(true)
  }, [])

  const handleClaim = useCallback(async () => {
    if (!active) return
    await client.claimFromSea(active.id)
    notify({ type: 'success', title: '已领取客户', message: active.name })
    setActive(null)
    setDrawerOpen(false)
  }, [active, client, notify])

  return (
    <>
      <CrmTable<Customer>
        queryKey="sea"
        fetchPage={fetchPage}
        columns={columns}
        rowKey="id"
        emptyText="公海暂无客户"
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

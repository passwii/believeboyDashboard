'use client'

import { useCallback, useState } from 'react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { Badge } from '@/components/ui/badge'
import { CrmTable } from './crm-table'
import type { CrmColumnDef } from './crm-table/types'
import { CrmOverviewDrawer } from './crm-overview-drawer'
import { OPPORTUNITY_FIELD_DEFS } from '@/lib/crm/field-defs/opportunity'
import type { Opportunity } from '@/lib/crm/types'
import {
  OPPORTUNITY_STAGE_COLORS,
  OPPORTUNITY_STAGE_LABELS,
} from '@/lib/crm/enums/opportunity.enum'

const columns: CrmColumnDef<Opportunity>[] = [
  { key: 'name', title: '商机名', sortable: true },
  { key: 'customerName', title: '客户' },
  {
    key: 'stage',
    title: '阶段',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(OPPORTUNITY_STAGE_LABELS) as Array<keyof typeof OPPORTUNITY_STAGE_LABELS>).map(
        (k) => [k, { label: OPPORTUNITY_STAGE_LABELS[k], color: OPPORTUNITY_STAGE_COLORS[k] }]
      )
    ),
  },
  { key: 'amount', title: '金额', format: 'number' },
  { key: 'probability', title: '赢单率', format: 'number' },
  { key: 'ownerName', title: '负责人' },
  {
    key: 'expectedCloseDate',
    title: '预计成交',
    format: 'date',
  },
]

export function CrmOpportunityTable() {
  const client = useCrmClient()
  const [active, setActive] = useState<Opportunity | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const fetchPage = useCallback(
    async (params: Parameters<typeof client.listOpportunities>[0]) => {
      return client.listOpportunities(params)
    },
    [client]
  )

  const handleRowClick = useCallback(async (row: Opportunity) => {
    setActive(row)
    setDrawerOpen(true)
  }, [])

  return (
    <>
      <CrmTable<Opportunity>
        queryKey="opportunities"
        fetchPage={fetchPage}
        columns={columns}
        rowKey="id"
        emptyText="暂无商机"
        defaultPageSize={20}
        onRowClick={handleRowClick}
      />
      {active && (
        <CrmOverviewDrawer<Opportunity>
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          entityType="opportunity"
          entityId={active.id}
          data={active}
          fields={OPPORTUNITY_FIELD_DEFS}
          title={active.name}
          headerExtra={
            <Badge variant="secondary" className={OPPORTUNITY_STAGE_COLORS[active.stage]}>
              {OPPORTUNITY_STAGE_LABELS[active.stage]}
            </Badge>
          }
          users={[]}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={async () => {
            /* 商机只读，不保存 */
          }}
        />
      )}
    </>
  )
}

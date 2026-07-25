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
import { CrmLeadForm } from './crm-lead-form'
import { CrmExportButton } from './crm-export-button'
import { LEAD_FIELD_DEFS } from '@/lib/crm/field-defs/lead'
import type { Lead } from '@/lib/crm/types'
import {
  LEAD_INTENT_COLORS,
  LEAD_INTENT_LABELS,
  LEAD_STATUS_COLORS,
  LEAD_STATUS_LABELS,
} from '@/lib/crm/enums/lead.enum'
import { CUSTOMER_SOURCE_LABELS } from '@/lib/crm/enums/customer.enum'

const columns: CrmColumnDef<Lead>[] = [
  { key: 'name', title: '联系人', sortable: true },
  { key: 'company', title: '公司' },
  {
    key: 'status',
    title: '状态',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(LEAD_STATUS_LABELS) as Array<keyof typeof LEAD_STATUS_LABELS>).map((k) => [
        k,
        { label: LEAD_STATUS_LABELS[k], color: LEAD_STATUS_COLORS[k] },
      ])
    ),
  },
  {
    key: 'intent',
    title: '意向',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(LEAD_INTENT_LABELS) as Array<keyof typeof LEAD_INTENT_LABELS>).map((k) => [
        k,
        { label: LEAD_INTENT_LABELS[k], color: LEAD_INTENT_COLORS[k] },
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
        { label: CUSTOMER_SOURCE_LABELS[k], color: 'bg-slate-100 text-slate-700' },
      ])
    ),
  },
  { key: 'ownerName', title: '负责人' },
  {
    key: 'expectedAmount',
    title: '预计金额',
    format: 'number',
  },
]

export function CrmLeadTable() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''
  const [active, setActive] = useState<Lead | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 表头快捷筛选字段（field 用后端 filter_engine 白名单的驼峰名）。
  // 对象类型/意向服务暂无枚举常量，选项与后端字段语义保持一致。
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
        options: ['工厂', '贸易商', '同行', '其他'].map((v) => ({ value: v, label: v })),
      },
      {
        key: 'interestedService',
        label: '意向服务',
        type: 'select',
        field: 'interestedService',
        options: ['代运营', 'AI运营', '运营服务', '其他'].map((v) => ({ value: v, label: v })),
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
    async (params: Parameters<typeof client.listLeads>[0]) => {
      return client.listLeads({ ...params, scope: scope ?? params.scope })
    },
    [client, scope]
  )

  const handleRowClick = useCallback(async (row: Lead) => {
    setActive(row)
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
    notify({ type: 'success', title: '已转化为客户', message: `线索「${active.name}」转为客户` })
    setDrawerOpen(false)
  }, [active, client, notify])

  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-2">
        <CrmExportButton entity="leads" scope={scope} keyword={keyword} />
      </div>
      <CrmTable<Lead>
        queryKey="leads"
        fetchPage={fetchPage}
        columns={columns}
        filterFields={leadFilterFields}
        rowKey="id"
        emptyText="暂无线索"
        defaultPageSize={20}
        onRowClick={handleRowClick}
      />
      {active && (
        <CrmOverviewDrawer<Lead>
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          entityType="lead"
          entityId={active.id}
          data={active}
          fields={LEAD_FIELD_DEFS}
          title={active.name}
          actions={
            active.status !== 'converted' && active.status !== 'discarded' ? (
              <Button size="sm" variant="default" onClick={handleConvert}>
                转为客户
              </Button>
            ) : undefined
          }
          headerExtra={
            <Badge variant="secondary" className={LEAD_STATUS_COLORS[active.status]}>
              {LEAD_STATUS_LABELS[active.status]}
            </Badge>
          }
          users={users}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSave}
          editForm={
            <CrmLeadForm
              users={users}
              initialValues={active}
              onSubmit={handleLeadFormSave}
              submitText="保存修改"
            />
          }
        />
      )}
    </>
  )
}

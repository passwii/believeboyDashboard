'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, ChevronRight, Inbox } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useNotifications } from '@/components/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CrmOverviewDrawer } from '../crm-overview-drawer'
import { CrmLeadForm } from '../crm-lead-form'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import { LEAD_FIELD_DEFS } from '@/lib/crm/field-defs/lead'
import {
  CUSTOMER_RATING_COLORS,
  CUSTOMER_RATING_LABELS,
  CUSTOMER_STATUS_COLORS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'
import { LEAD_STATUS_COLORS, LEAD_STATUS_LABELS } from '@/lib/crm/enums/lead.enum'
import type { Customer, FollowUpGroups, FollowUpItem, Lead } from '@/lib/crm/types'
import type { LeadInput } from '@/lib/crm/types/lead'

type GroupKey = 'overdue' | 'today' | 'thisWeek'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 下次跟进时间的展示文案（按所属分组）。 */
function formatNextFollow(iso: string, group: GroupKey): string {
  const d = new Date(iso)
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (group === 'overdue') {
    const days = Math.round((startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / 86400000)
    return days > 0 ? `逾期 ${days} 天` : '逾期'
  }
  if (group === 'today') return `今天 ${hm}`
  return `${WEEKDAYS[d.getDay()]} ${hm}`
}

const GROUPS: Array<{ key: GroupKey; label: string; accent: string }> = [
  { key: 'overdue', label: '逾期未跟进', accent: 'text-rose-600 dark:text-rose-400' },
  { key: 'today', label: '今日待跟进', accent: 'text-amber-600 dark:text-amber-400' },
  { key: 'thisWeek', label: '本周待跟进', accent: 'text-slate-600 dark:text-slate-300' },
]

export function CrmFollowUpList() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const [groups, setGroups] = useState<FollowUpGroups | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [activeCustomer, setActiveCustomer] = useState<Customer | null>(null)
  const [activeLead, setActiveLead] = useState<Lead | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setGroups(await client.listFollowUps(scope))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载待跟进失败')
    } finally {
      setLoading(false)
    }
  }, [client, scope])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const openItem = useCallback(
    async (item: FollowUpItem) => {
      try {
        if (item.entityType === 'customer') {
          setActiveCustomer(await client.getCustomer(item.entityId))
          setActiveLead(null)
        } else {
          setActiveLead(await client.getLead(item.entityId))
          setActiveCustomer(null)
        }
        setDrawerOpen(true)
      } catch (e) {
        notify({
          type: 'error',
          title: '打开详情失败',
          message: e instanceof Error ? e.message : undefined,
        })
      }
    },
    [client, notify]
  )

  const handleDrawerChange = useCallback((open: boolean) => {
    setDrawerOpen(open)
    if (!open) {
      setActiveCustomer(null)
      setActiveLead(null)
      setRefreshKey((k) => k + 1) // 记跟进后 nextFollowAt 变化，刷新列表
    }
  }, [])

  const handleSaveCustomer = useCallback(
    async (input: Record<string, unknown>) => {
      if (!activeCustomer) return
      const updated = await client.updateCustomer(activeCustomer.id, input as never)
      setActiveCustomer(updated)
      setDrawerOpen(false)
    },
    [activeCustomer, client]
  )

  const handleSaveLead = useCallback(
    async (input: Record<string, unknown>) => {
      if (!activeLead) return
      const updated = await client.updateLead(activeLead.id, input as never)
      setActiveLead(updated)
      setDrawerOpen(false)
    },
    [activeLead, client]
  )

  const handleLeadFormSave = useCallback(
    async (input: LeadInput) => {
      if (!activeLead) return
      const updated = await client.updateLead(activeLead.id, input)
      setActiveLead(updated)
      setDrawerOpen(false)
    },
    [activeLead, client]
  )

  const handleConvert = useCallback(async () => {
    if (!activeLead) return
    await client.convertLead(activeLead.id)
    notify({ type: 'success', title: '已转化为客户', message: `线索「${activeLead.name}」转为客户` })
    setDrawerOpen(false)
  }, [activeLead, client, notify])

  if (loading && !groups) {
    return <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
  }
  if (error) {
    return <div className="py-16 text-center text-sm text-rose-600">{error}</div>
  }
  if (!groups || groups.totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-muted-foreground">
        <Inbox className="h-10 w-10" />
        <p className="text-sm">暂无待跟进，太棒了 🎉</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const items = groups[g.key]
        if (items.length === 0) return null
        return (
          <section key={g.key}>
            <div className="mb-2 flex items-center gap-2">
              {g.key === 'overdue' ? (
                <AlertCircle className="h-4 w-4 text-rose-600" />
              ) : (
                <CalendarClock className={`h-4 w-4 ${g.accent}`} />
              )}
              <h2 className={`text-sm font-semibold ${g.accent}`}>{g.label}</h2>
              <Badge
                variant="secondary"
                className={g.key === 'overdue' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : ''}
              >
                {items.length}
              </Badge>
            </div>
            <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
              {items.map((item) => (
                <FollowUpRow
                  key={`${item.entityType}-${item.entityId}`}
                  item={item}
                  group={g.key}
                  onClick={() => openItem(item)}
                />
              ))}
            </div>
          </section>
        )
      })}

      {activeCustomer && (
        <CrmOverviewDrawer<Customer>
          open={drawerOpen}
          onOpenChange={handleDrawerChange}
          entityType="customer"
          entityId={activeCustomer.id}
          data={activeCustomer}
          fields={CUSTOMER_FIELD_DEFS}
          title={activeCustomer.name}
          headerExtra={
            <Badge variant="secondary" className={CUSTOMER_STATUS_COLORS[activeCustomer.status]}>
              {CUSTOMER_STATUS_LABELS[activeCustomer.status]}
            </Badge>
          }
          users={[]}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSaveCustomer}
        />
      )}
      {activeLead && (
        <CrmOverviewDrawer<Lead>
          open={drawerOpen}
          onOpenChange={handleDrawerChange}
          entityType="lead"
          entityId={activeLead.id}
          data={activeLead}
          fields={LEAD_FIELD_DEFS}
          title={activeLead.name}
          actions={
            activeLead.status !== 'converted' && activeLead.status !== 'discarded' ? (
              <Button size="sm" onClick={handleConvert}>
                转为客户
              </Button>
            ) : undefined
          }
          headerExtra={
            <Badge variant="secondary" className={LEAD_STATUS_COLORS[activeLead.status]}>
              {LEAD_STATUS_LABELS[activeLead.status]}
            </Badge>
          }
          users={[]}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSaveLead}
          editForm={
            <CrmLeadForm
              users={[]}
              initialValues={activeLead}
              onSubmit={handleLeadFormSave}
              submitText="保存修改"
            />
          }
        />
      )}
    </div>
  )
}

function FollowUpRow({
  item,
  group,
  onClick,
}: {
  item: FollowUpItem
  group: GroupKey
  onClick: () => void
}) {
  const isCustomer = item.entityType === 'customer'
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
    >
      <Badge
        variant="outline"
        className={
          isCustomer ? 'border-blue-200 text-blue-700' : 'border-violet-200 text-violet-700'
        }
      >
        {isCustomer ? '客户' : '线索'}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {isCustomer && item.rating && (
            <Badge
              variant="secondary"
              className={CUSTOMER_RATING_COLORS[item.rating as keyof typeof CUSTOMER_RATING_COLORS] ?? ''}
            >
              {CUSTOMER_RATING_LABELS[item.rating as keyof typeof CUSTOMER_RATING_LABELS] ?? item.rating}
            </Badge>
          )}
          {item.subtitle && (
            <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
          )}
        </div>
        {item.lastFollowContent && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">上次：{item.lastFollowContent}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className={`text-xs font-medium ${group === 'overdue' ? 'text-rose-600' : 'text-muted-foreground'}`}
        >
          {formatNextFollow(item.nextFollowAt, group)}
        </span>
        {item.ownerName && <span className="text-xs text-muted-foreground">{item.ownerName}</span>}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

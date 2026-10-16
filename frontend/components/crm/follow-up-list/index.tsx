'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, ChevronRight, Inbox } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CrmOverviewDrawer } from '../crm-overview-drawer'
import { CrmLeadForm } from '../crm-lead-form'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import { LEAD_FIELD_DEFS } from '@/lib/crm/field-defs/lead'
import {
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
  { key: 'overdue', label: '逾期未跟进', accent: 'text-term-neg' },
  { key: 'today', label: '今日待跟进', accent: 'text-term-warn' },
  { key: 'thisWeek', label: '本周待跟进', accent: 'text-term-muted' },
]

export function CrmFollowUpList() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const users = useCrmUsers()
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

  useHeaderRefresh(load, { loading })

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
    return <div className="py-16 text-center font-mono text-xs text-term-faint">加载中…</div>
  }
  if (error && !groups) {
    return (
      <div
        role="alert"
        className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
      >
        ERR · {error}
      </div>
    )
  }
  if (!groups || groups.totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-term-faint" aria-busy={loading}>
        {error && <p role="alert" className="font-mono text-xs text-term-neg">刷新失败：{error}</p>}
        <Inbox className="h-10 w-10" />
        <p className="font-mono text-xs">暂无待跟进，太棒了</p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={loading}>
      {error && (
        <div role="alert" className="font-mono text-xs text-term-neg">
          刷新失败：{error}
        </div>
      )}
      {GROUPS.map((g) => {
        const items = groups[g.key]
        if (items.length === 0) return null
        return (
          <section key={g.key}>
            <div className="mb-1.5 flex items-center gap-1.5">
              {g.key === 'overdue' ? (
                <AlertCircle className="h-4 w-4 text-term-neg" strokeWidth={1.75} />
              ) : (
                <CalendarClock className={`h-4 w-4 ${g.accent}`} strokeWidth={1.75} />
              )}
              <h2 className={`font-mono text-xs uppercase tracking-wider ${g.accent}`}>
                {g.label}
              </h2>
              <span
                className={cn(
                  'border border-term-border bg-term-panel px-1 font-mono text-xs tabular-nums',
                  g.key === 'overdue' ? 'text-term-neg' : 'text-term-muted'
                )}
              >
                {items.length}
              </span>
            </div>
            {/* BLF-837：分组列表零圆角 + term 边界 */}
            <div className="divide-y divide-term-border border border-term-border">
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
          users={users}
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
          users={users}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={handleSaveLead}
          editForm={
            <CrmLeadForm
              users={users}
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
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-term-hover"
    >
      <span
        className={cn(
          'shrink-0 border px-1 font-mono text-[11px]',
          isCustomer ? 'border-term-accent/40 text-term-accent' : 'border-term-border text-term-muted'
        )}
      >
        {isCustomer ? '客户' : '线索'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-term-text">{item.name}</span>
          {isCustomer && item.rating && (
            <span
              className={cn(
                'shrink-0 border border-term-border px-1 font-mono text-[11px]',
                (item.rating as string) === 'A' ? 'text-term-accent' : 'text-term-muted'
              )}
            >
              {item.rating}
            </span>
          )}
          {item.subtitle && (
            <span className="truncate text-xs text-term-faint">{item.subtitle}</span>
          )}
        </div>
        {item.lastFollowContent && (
          <p className="mt-0.5 truncate text-xs text-term-faint">上次：{item.lastFollowContent}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            group === 'overdue' ? 'font-medium text-term-neg' : 'text-term-muted'
          )}
        >
          {formatNextFollow(item.nextFollowAt, group)}
        </span>
        {item.ownerName && (
          <span className="font-mono text-xs text-term-faint">{item.ownerName}</span>
        )}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-term-faint" strokeWidth={1.75} />
    </button>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, ChevronRight } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmBadge, WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { CrmOverviewDrawer } from '../crm-overview-drawer'
import { CrmLeadForm } from '../crm-lead-form'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import { LEAD_FIELD_DEFS } from '@/lib/crm/field-defs/lead'
import { CUSTOMER_STATUS_LABELS } from '@/lib/crm/enums/customer.enum'
import { LEAD_STATUS_LABELS } from '@/lib/crm/enums/lead.enum'
import type { Customer, FollowUpGroups, FollowUpItem, Lead } from '@/lib/crm/types'
import type { LeadInput } from '@/lib/crm/types/lead'

import styles from './follow-up-list-warm.module.css'

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

const GROUPS: Array<{ key: GroupKey; label: string; tone: 'negative' | 'accent' | 'neutral' }> = [
  { key: 'overdue', label: '逾期未跟进', tone: 'negative' },
  { key: 'today', label: '今日待跟进', tone: 'accent' },
  { key: 'thisWeek', label: '本周待跟进', tone: 'neutral' },
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
    return <WarmCrmState kind="loading" title="加载中…" />
  }
  if (error && !groups) {
    return <WarmCrmState kind="error" title="待跟进加载失败" detail={error} />
  }
  if (!groups || groups.totalCount === 0) {
    return (
      <div className={styles.page} aria-busy={loading}>
        {error ? (
          <div role="alert" className={styles.alert}>
            刷新失败：{error}
          </div>
        ) : null}
        <WarmCrmState kind="empty" title="暂无待跟进，太棒了" />
      </div>
    )
  }

  return (
    <div className={styles.page} aria-busy={loading}>
      {error && (
        <div role="alert" className={styles.alert}>
          刷新失败：{error}
        </div>
      )}
      {GROUPS.map((g) => {
        const items = groups[g.key]
        if (items.length === 0) return null
        return (
          <WarmCrmSection
            key={g.key}
            className={styles.group}
            data-warm-crm-follow-group
            data-tone={g.tone}
            title={
              <span className={styles.groupTitle}>
                {g.key === 'overdue' ? (
                  <AlertCircle className={styles.groupIcon} strokeWidth={1.75} />
                ) : (
                  <CalendarClock className={styles.groupIcon} strokeWidth={1.75} />
                )}
                <span className={styles.groupTitleText}>{g.label}</span>
              </span>
            }
            actions={
              <WarmBadge tone={g.tone === 'negative' ? 'negative' : g.tone === 'accent' ? 'accent' : 'neutral'}>
                {items.length}
              </WarmBadge>
            }
            bodyClassName={styles.sectionBody}
          >
            <div className={styles.list}>
              {items.map((item) => (
                <FollowUpRow
                  key={`${item.entityType}-${item.entityId}`}
                  item={item}
                  group={g.key}
                  onClick={() => openItem(item)}
                />
              ))}
            </div>
          </WarmCrmSection>
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
            <WarmCrmStatusPill>
              {CUSTOMER_STATUS_LABELS[activeCustomer.status]}
            </WarmCrmStatusPill>
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
              <WarmButton variant="primary" onClick={handleConvert}>
                转为客户
              </WarmButton>
            ) : undefined
          }
          headerExtra={
            <WarmCrmStatusPill>
              {LEAD_STATUS_LABELS[activeLead.status]}
            </WarmCrmStatusPill>
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
      className={styles.row}
    >
      <WarmCrmStatusPill
        className={`${styles.kind} ${isCustomer ? styles.kindCustomer : ''}`}
        tone={isCustomer ? 'accent' : 'neutral'}
      >
        {isCustomer ? '客户' : '线索'}
      </WarmCrmStatusPill>
      <div className={styles.main}>
        <div className={styles.titleLine}>
          <span className={styles.name}>{item.name}</span>
          {isCustomer && item.rating && (
            <WarmCrmStatusPill tone={(item.rating as string) === 'A' ? 'accent' : 'neutral'}>
              {item.rating}
            </WarmCrmStatusPill>
          )}
          {item.subtitle && (
            <span className={styles.subtitle}>{item.subtitle}</span>
          )}
        </div>
        {item.lastFollowContent && (
          <p className={styles.lastFollow}>上次：{item.lastFollowContent}</p>
        )}
      </div>
      <div className={styles.meta}>
        <span
          className={`${styles.nextFollow} ${group === 'overdue' ? styles.nextFollowOverdue : ''}`}
        >
          {formatNextFollow(item.nextFollowAt, group)}
        </span>
        {item.ownerName && (
          <span className={styles.owner}>{item.ownerName}</span>
        )}
      </div>
      <ChevronRight className={styles.chevron} strokeWidth={1.75} />
    </button>
  )
}

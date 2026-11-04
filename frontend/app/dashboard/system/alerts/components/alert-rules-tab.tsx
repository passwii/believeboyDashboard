'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import {
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
  type AlertRuleItem,
} from '@/lib/alerts-api'
import { AlertRuleDialog } from './alert-rule-dialog'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { cn } from '@/lib/utils'
import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import styles from '../alerts-warm.module.css'
import { AlertWarmSwitch } from './alert-warm-switch'

interface ProjectOption {
  id: number
  name: string
}

const SEVERITY_TONE: Record<string, WarmBadgeTone> = {
  critical: 'negative',
  warning: 'accent',
  info: 'neutral',
}

export function AlertRulesTab({
  projects,
  onRefreshReady,
}: {
  projects: ProjectOption[]
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const { notify } = useNotifications()
  const [rules, setRules] = useState<AlertRuleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRuleItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await fetchAlertRules())
    } catch (err) {
      notify({ type: 'error', title: '加载规则失败', message: String(err) })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

  const toggleActive = async (rule: AlertRuleItem) => {
    try {
      await updateAlertRule(rule.id, { is_active: !rule.is_active })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '切换失败', message: String(err) })
    }
  }

  const onDelete = async (rule: AlertRuleItem) => {
    if (!confirm(`确认删除规则「${rule.name}」？`)) return
    try {
      await deleteAlertRule(rule.id)
      notify({ type: 'success', title: '规则已删除' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '删除失败', message: String(err) })
    }
  }

  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `#${id}`

  return (
    <div className={styles.tabPanel} data-warm-alert-rules="true">
      <div className={styles.toolbar}>
        <WarmButton
          variant="primary"
          onClick={() => { setEditing(null); setDialogOpen(true) }}
        >
          <Plus className={styles.actionIcon} aria-hidden /> 新建规则
        </WarmButton>
      </div>

      <section className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table} aria-label="告警规则">
            <thead>
              <tr>
                <th>名称</th>
                <th>项目</th>
                <th>指标</th>
                <th>条件</th>
                <th className={styles.numericCell}>阈值</th>
                <th>级别</th>
                <th className={styles.centerCell}>启用</th>
                <th className={styles.numericCell}>操作</th>
              </tr>
            </thead>
            <tbody>
            {loading ? (
              <tr><td colSpan={8} className={styles.emptyCell}>加载中…</td></tr>
            ) : rules.length === 0 ? (
              <tr><td colSpan={8} className={styles.emptyCell}>暂无规则，点击右上角新建</td></tr>
            ) : (
              rules.map((r) => (
                <tr key={r.id}>
                  <td className={styles.nameCell}>{r.name}</td>
                  <td>{projectName(r.project_id)}</td>
                  <td>{r.metric}</td>
                  <td className={styles.mutedCell}>{r.condition}</td>
                  <td className={styles.numericCell} data-tone={r.severity}>
                    {r.threshold}%
                  </td>
                  <td>
                    <WarmBadge tone={SEVERITY_TONE[r.severity] ?? 'neutral'}>
                      {r.severity}
                    </WarmBadge>
                  </td>
                  <td className={styles.switchCell}>
                    <AlertWarmSwitch
                      checked={r.is_active}
                      label={`启用规则 ${r.name}`}
                      onCheckedChange={() => toggleActive(r)}
                    />
                  </td>
                  <td className={styles.actionCell}>
                    <WarmButton
                      className={styles.rowAction}
                      onClick={() => { setEditing(r); setDialogOpen(true) }}
                    >
                      编辑
                    </WarmButton>
                    <WarmButton
                      variant="quiet"
                      className={cn(styles.rowAction, styles.dangerAction)}
                      onClick={() => onDelete(r)}
                    >
                      删除
                    </WarmButton>
                  </td>
                </tr>
              ))
            )}
            </tbody>
          </table>
        </div>
      </section>

      <AlertRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        projects={projects}
        onSaved={load}
      />
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { useNotifications } from '@/components/notifications'
import {
  createAlertRule,
  fetchMetricOptions,
  updateAlertRule,
  type AlertRuleItem,
  type AlertRulePayload,
  type MetricOption,
} from '@/lib/alerts-api'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import styles from '../alerts-warm.module.css'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './alert-warm-dialog'

interface ProjectOption {
  id: number
  name: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑态传入已有规则；新建态为 null */
  rule: AlertRuleItem | null
  projects: ProjectOption[]
  onSaved: () => void
}

const EMPTY: AlertRulePayload = {
  name: '',
  project_id: 0,
  country: 'US',
  metric: 'sales_amount',
  trigger_type: 'threshold',
  condition: 'drop_pct',
  threshold: 20,
  window_days: 7,
  severity: 'warning',
  notification_channels: 'in_app',
}

export function AlertRuleDialog({ open, onOpenChange, rule, projects, onSaved }: Props) {
  const { notify } = useNotifications()
  const [form, setForm] = useState<AlertRulePayload>(EMPTY)
  const [metrics, setMetrics] = useState<MetricOption[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    void fetchMetricOptions().then(setMetrics).catch(() => setMetrics([]))
    if (rule) {
      setForm({
        name: rule.name,
        project_id: rule.project_id,
        country: rule.country,
        metric: rule.metric,
        trigger_type: rule.trigger_type,
        condition: rule.condition,
        threshold: rule.threshold,
        window_days: rule.window_days,
        severity: rule.severity,
        notification_channels: rule.notification_channels,
      })
    } else {
      setForm({ ...EMPTY, project_id: projects[0]?.id ?? 0 })
    }
  }, [open, rule, projects])

  const set = <K extends keyof AlertRulePayload>(key: K, value: AlertRulePayload[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    if (!form.name.trim()) {
      notify({ type: 'error', title: '请填写规则名称' })
      return
    }
    if (!form.project_id) {
      notify({ type: 'error', title: '请选择项目' })
      return
    }
    setSaving(true)
    try {
      if (rule) {
        await updateAlertRule(rule.id, form)
        notify({ type: 'success', title: '规则已更新' })
      } else {
        await createAlertRule(form)
        notify({ type: 'success', title: '规则已创建' })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{rule ? '编辑告警规则' : '新建告警规则'}</DialogTitle>
        </DialogHeader>
        <div className={styles.ruleForm}>
          <div className={styles.field}>
            <label htmlFor="alert-rule-name" className={styles.fieldLabel}>名称</label>
            <input
              id="alert-rule-name"
              className={styles.input}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="如：US 销售额骤降"
            />
          </div>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label htmlFor="alert-rule-project" className={styles.fieldLabel}>项目</label>
              <select
                id="alert-rule-project"
                className={styles.selectTrigger}
                value={String(form.project_id)}
                onChange={(event) => set('project_id', Number(event.target.value))}
              >
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="alert-rule-country" className={styles.fieldLabel}>国家</label>
              <input
                id="alert-rule-country"
                className={styles.input}
                value={form.country}
                onChange={(e) => set('country', e.target.value)}
              />
            </div>
          </div>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label htmlFor="alert-rule-metric" className={styles.fieldLabel}>指标</label>
              <select
                id="alert-rule-metric"
                className={styles.selectTrigger}
                value={form.metric}
                onChange={(event) => set('metric', event.target.value)}
              >
                {metrics.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="alert-rule-condition" className={styles.fieldLabel}>条件</label>
              <select
                id="alert-rule-condition"
                className={styles.selectTrigger}
                value={form.condition}
                onChange={(event) => set('condition', event.target.value)}
              >
                <option value="drop_pct">下降超过 %</option>
                <option value="rise_pct">上升超过 %</option>
                <option value="below">低于基线 %</option>
                <option value="above">高于基线 %</option>
              </select>
            </div>
          </div>
          <div className={styles.formRowThree}>
            <div className={styles.field}>
              <label htmlFor="alert-rule-threshold" className={styles.fieldLabel}>阈值 (%)</label>
              <input
                id="alert-rule-threshold"
                className={styles.input}
                type="number"
                value={form.threshold}
                onChange={(e) => set('threshold', Number(e.target.value))}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="alert-rule-window" className={styles.fieldLabel}>窗口 (天)</label>
              <input
                id="alert-rule-window"
                className={styles.input}
                type="number"
                value={form.window_days}
                onChange={(e) => set('window_days', Number(e.target.value))}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="alert-rule-severity" className={styles.fieldLabel}>级别</label>
              <select
                id="alert-rule-severity"
                className={styles.selectTrigger}
                value={form.severity}
                onChange={(event) => set('severity', event.target.value)}
              >
                <option value="info">提示</option>
                <option value="warning">警告</option>
                <option value="critical">严重</option>
              </select>
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="alert-rule-channel" className={styles.fieldLabel}>通知通道</label>
            <select
              id="alert-rule-channel"
              className={styles.selectTrigger}
              value={form.notification_channels}
              onChange={(event) => set('notification_channels', event.target.value)}
            >
              <option value="in_app">站内</option>
              <option value="email">邮件</option>
              <option value="both">站内 + 邮件</option>
            </select>
          </div>
        </div>
        <DialogFooter className={styles.dialogFooter}>
          <WarmButton onClick={() => onOpenChange(false)}>取消</WarmButton>
          <WarmButton
            variant="primary"
            onClick={submit}
            disabled={saving}
            loading={saving}
            loadingLabel="正在保存告警规则"
          >
            {saving ? '保存中…' : '保存'}
          </WarmButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

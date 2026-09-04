'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/components/notifications'
import {
  createAlertRule,
  fetchMetricOptions,
  updateAlertRule,
  type AlertRuleItem,
  type AlertRulePayload,
  type MetricOption,
} from '@/lib/alerts-api'

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
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? '编辑告警规则' : '新建告警规则'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：US 销售额骤降" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>项目</Label>
              <Select value={String(form.project_id)} onValueChange={(v) => set('project_id', Number(v))}>
                <SelectTrigger><SelectValue placeholder="选择项目" /></SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>国家</Label>
              <Input value={form.country} onChange={(e) => set('country', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>指标</Label>
              <Select value={form.metric} onValueChange={(v) => set('metric', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {metrics.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>条件</Label>
              <Select value={form.condition} onValueChange={(v) => set('condition', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="drop_pct">下降超过 %</SelectItem>
                  <SelectItem value="rise_pct">上升超过 %</SelectItem>
                  <SelectItem value="below">低于基线 %</SelectItem>
                  <SelectItem value="above">高于基线 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>阈值 (%)</Label>
              <Input type="number" value={form.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
            </div>
            <div className="grid gap-1.5">
              <Label>窗口 (天)</Label>
              <Input type="number" value={form.window_days} onChange={(e) => set('window_days', Number(e.target.value))} />
            </div>
            <div className="col-span-2 grid gap-1.5 sm:col-span-1">
              <Label>级别</Label>
              <Select value={form.severity} onValueChange={(v) => set('severity', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">提示</SelectItem>
                  <SelectItem value="warning">警告</SelectItem>
                  <SelectItem value="critical">严重</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>通知通道</Label>
            <Select value={form.notification_channels} onValueChange={(v) => set('notification_channels', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in_app">站内</SelectItem>
                <SelectItem value="email">邮件</SelectItem>
                <SelectItem value="both">站内 + 邮件</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

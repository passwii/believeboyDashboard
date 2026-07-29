'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useNotifications } from '@/components/notifications'
import {
  fetchAlertPreferences,
  updateAlertPreferences,
  type AlertPreference,
} from '@/lib/alerts-api'

export function AlertPreferencesTab() {
  const { notify } = useNotifications()
  const [pref, setPref] = useState<AlertPreference | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchAlertPreferences()
      .then(setPref)
      .catch((err) => notify({ type: 'error', title: '加载偏好失败', message: String(err) }))
  }, [notify])

  if (!pref) {
    return <div className="py-8 text-center text-muted-foreground">加载中…</div>
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await updateAlertPreferences(pref)
      setPref(updated)
      notify({ type: 'success', title: '偏好已保存' })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-surface max-w-xl space-y-6 rounded-xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <Label>邮件通知</Label>
          <p className="text-xs text-muted-foreground">告警触发时发送邮件</p>
        </div>
        <Switch
          checked={pref.email_enabled}
          onCheckedChange={(v) => setPref({ ...pref, email_enabled: v })}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>站内通知</Label>
          <p className="text-xs text-muted-foreground">告警触发时写入通知中心（铃铛）</p>
        </div>
        <Switch
          checked={pref.in_app_enabled}
          onCheckedChange={(v) => setPref({ ...pref, in_app_enabled: v })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>最低告警级别</Label>
        <Select value={pref.min_severity} onValueChange={(v) => setPref({ ...pref, min_severity: v })}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="info">提示及以上</SelectItem>
            <SelectItem value="warning">警告及以上</SelectItem>
            <SelectItem value="critical">仅严重</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>免打扰开始</Label>
          <Input
            type="time"
            value={pref.quiet_hours_start ?? ''}
            onChange={(e) => setPref({ ...pref, quiet_hours_start: e.target.value || null })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>免打扰结束</Label>
          <Input
            type="time"
            value={pref.quiet_hours_end ?? ''}
            onChange={(e) => setPref({ ...pref, quiet_hours_end: e.target.value || null })}
          />
        </div>
      </div>
      <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存偏好'}</Button>
    </div>
  )
}
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

function arePreferencesEqual(left: AlertPreference, right: AlertPreference): boolean {
  return (
    left.email_enabled === right.email_enabled &&
    left.in_app_enabled === right.in_app_enabled &&
    left.min_severity === right.min_severity &&
    left.quiet_hours_start === right.quiet_hours_start &&
    left.quiet_hours_end === right.quiet_hours_end
  )
}

export function AlertPreferencesTab({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const { notify } = useNotifications()
  const [pref, setPref] = useState<AlertPreference | null>(null)
  const prefRef = useRef<AlertPreference | null>(null)
  const savedPrefRef = useRef<AlertPreference | null>(null)
  const [saving, setSaving] = useState(false)

  const updateDraft = useCallback((next: AlertPreference) => {
    prefRef.current = next
    setPref(next)
  }, [])

  const load = useCallback(async () => {
    try {
      const refreshed = await fetchAlertPreferences()
      const currentDraft = prefRef.current
      const savedPref = savedPrefRef.current
      if (!currentDraft || !savedPref || arePreferencesEqual(currentDraft, savedPref)) {
        savedPrefRef.current = refreshed
        updateDraft(refreshed)
      }
    } catch (err) {
      notify({ type: 'error', title: '加载偏好失败', message: String(err) })
    }
  }, [notify, updateDraft])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

  if (!pref) {
    return <div className="py-8 text-center font-mono text-xs text-term-faint">加载中…</div>
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await updateAlertPreferences(pref)
      savedPrefRef.current = updated
      updateDraft(updated)
      notify({ type: 'success', title: '偏好已保存' })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    // BLF-838：偏好设置卡走 TermPanel 终端规格，输入 mono 化
    <div className="max-w-xl space-y-6 border border-term-border bg-term-panel px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <Label>邮件通知</Label>
          <p className="text-xs text-term-faint">告警触发时发送邮件</p>
        </div>
        <Switch
          checked={pref.email_enabled}
          onCheckedChange={(v) => updateDraft({ ...pref, email_enabled: v })}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>站内通知</Label>
          <p className="text-xs text-term-faint">告警触发时写入通知中心（铃铛）</p>
        </div>
        <Switch
          checked={pref.in_app_enabled}
          onCheckedChange={(v) => updateDraft({ ...pref, in_app_enabled: v })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>最低告警级别</Label>
        <Select value={pref.min_severity} onValueChange={(v) => updateDraft({ ...pref, min_severity: v })}>
          <SelectTrigger className={`w-40 rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem className="rounded-none text-xs focus:bg-term-hover focus:text-term-text" value="info">提示及以上</SelectItem>
            <SelectItem className="rounded-none text-xs focus:bg-term-hover focus:text-term-text" value="warning">警告及以上</SelectItem>
            <SelectItem className="rounded-none text-xs focus:bg-term-hover focus:text-term-text" value="critical">仅严重</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>免打扰开始</Label>
          <Input
            type="time"
            className="h-9 rounded-none border-term-border bg-term-bg font-mono text-sm tabular-nums text-term-text shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            value={pref.quiet_hours_start ?? ''}
            onChange={(e) => updateDraft({ ...pref, quiet_hours_start: e.target.value || null })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>免打扰结束</Label>
          <Input
            type="time"
            className="h-9 rounded-none border-term-border bg-term-bg font-mono text-sm tabular-nums text-term-text shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            value={pref.quiet_hours_end ?? ''}
            onChange={(e) => updateDraft({ ...pref, quiet_hours_end: e.target.value || null })}
          />
        </div>
      </div>
      <Button onClick={save} disabled={saving} className="rounded-none font-mono text-xs">{saving ? '保存中…' : '保存偏好'}</Button>
    </div>
  )
}
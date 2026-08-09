'use client'

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { CrmRulesPanel } from '@/components/crm/crm-rules-panel'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { WorkflowSettings } from '@/lib/crm/types'

const MIN_DAYS = 1
const MAX_DAYS = 365

/**
 * CRM 设置页：规则引擎可视化编辑器（P9-7，BLF-545）+ 工作流自动化设置
 * （7 天无跟进提醒邮件，P9-2，BLF-540）。其余设置（自定义字段、阶段、来源等）
 * 随 V2 逐步开放。非管理员仅展示提示。
 */
export default function SettingsPage() {
  const { data: session, status: sessionStatus } = useSession()
  const client = useCrmClient()
  const { notify } = useNotifications()

  const isAdmin = session?.user?.roleType === 'admin'

  const [settings, setSettings] = useState<WorkflowSettings | null>(null)
  const [days, setDays] = useState('7')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    client
      .getWorkflowSettings()
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setDays(String(s.staleDays))
      })
      .catch((err) => {
        if (cancelled) return
        notify({ type: 'error', title: '加载设置失败', message: String(err) })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, isAdmin, notify])

  if (sessionStatus === 'loading') {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <h1 className="text-lg font-semibold tracking-tight">CRM 设置</h1>
        <Skeleton className="h-40 w-full max-w-2xl" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-xl font-semibold tracking-tight">CRM 设置</h1>
        <p className="text-sm text-muted-foreground">仅管理员可查看与修改设置</p>
      </div>
    )
  }

  if (loading || !settings) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <h1 className="text-lg font-semibold tracking-tight">CRM 设置</h1>
        <Skeleton className="h-40 w-full max-w-2xl" />
      </div>
    )
  }

  const daysNum = Number(days)
  const daysValid = Number.isInteger(daysNum) && daysNum >= MIN_DAYS && daysNum <= MAX_DAYS

  const save = async () => {
    if (!daysValid) {
      notify({
        type: 'warning',
        title: '天数不合法',
        message: `请输入 ${MIN_DAYS}-${MAX_DAYS} 之间的整数`,
      })
      return
    }
    setSaving(true)
    try {
      const updated = await client.updateWorkflowSettings({
        staleDays: daysNum,
        staleEmailEnabled: settings.staleEmailEnabled,
      })
      setSettings(updated)
      setDays(String(updated.staleDays))
      notify({ type: 'success', title: '设置已保存' })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">CRM 设置</h1>
        <p className="text-sm text-muted-foreground">工作流自动化配置</p>
      </div>

      <CrmRulesPanel />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">7 天无跟进提醒</CardTitle>
          <CardDescription>
            客户/线索超过阈值天数无跟进时，自动给负责人发送提醒邮件
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>提醒邮件</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                关闭后不再发送无跟进提醒邮件
              </p>
            </div>
            <Switch
              checked={settings.staleEmailEnabled}
              onCheckedChange={(v) => setSettings({ ...settings, staleEmailEnabled: v })}
              aria-label="提醒邮件开关"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="stale-days">无跟进天数</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                超过该天数未跟进即触发提醒（默认 7 天）
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id="stale-days"
                type="number"
                min={MIN_DAYS}
                max={MAX_DAYS}
                className="w-24"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">天</span>
            </div>
          </div>

          <div className="flex justify-end border-t pt-4">
            <Button onClick={save} disabled={saving || !daysValid}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { useSession } from 'next-auth/react'
import { CrmRulesPanel } from '@/components/crm/crm-rules-panel'
import { CrmCategoryManager } from '@/components/crm/crm-category-manager'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmPage,
  WarmCrmSection,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'
import type { WorkflowSettings } from '@/lib/crm/types'

import styles from './settings-warm.module.css'

const MIN_DAYS = 1
const MAX_DAYS = 365

/**
 * CRM 设置页：规则引擎 + 产品类目 + 工作流提醒设置。
 *
 * 管理员门槛、加载/刷新、保存入参与 children 刷新注册均保持现有行为。
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

  const [refreshing, setRefreshing] = useState(false)
  const [refreshOwners, setRefreshOwners] = useState<Array<() => Promise<void>>>([])
  const registerRefreshOwner = useCallback((refresh: () => Promise<void>) => {
    setRefreshOwners((owners) => [...owners.filter((owner) => owner !== refresh), refresh])
  }, [])

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    client
      .getWorkflowSettings()
      .then((nextSettings) => {
        if (cancelled) return
        setSettings(nextSettings)
        setDays(String(nextSettings.staleDays))
      })
      .catch((error) => {
        if (cancelled) return
        notify({ type: 'error', title: '加载设置失败', message: String(error) })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, isAdmin, notify])

  const refreshSettings = useCallback(async () => {
    if (!isAdmin) return
    setRefreshing(true)
    try {
      const refreshed = await client.getWorkflowSettings()
      setSettings(refreshed)
      await Promise.all(refreshOwners.map((refreshOwner) => refreshOwner()))
    } catch (error) {
      notify({ type: 'error', title: '刷新设置失败', message: String(error) })
    } finally {
      setRefreshing(false)
    }
  }, [client, isAdmin, notify, refreshOwners])

  useHeaderRefresh(refreshSettings, { loading: loading || refreshing })

  if (sessionStatus === 'loading') {
    return (
      <WarmCrmPage>
        <WarmCrmState kind="loading" title="加载中" />
      </WarmCrmPage>
    )
  }

  if (!isAdmin) {
    return (
      <WarmCrmPage>
        <WarmCrmState kind="empty" title="仅管理员可查看与修改设置" />
      </WarmCrmPage>
    )
  }

  if (loading || !settings) {
    return (
      <WarmCrmPage>
        <WarmCrmState kind="loading" title="加载中" />
      </WarmCrmPage>
    )
  }

  const daysNumber = Number(days)
  const daysValid =
    Number.isInteger(daysNumber) &&
    daysNumber >= MIN_DAYS &&
    daysNumber <= MAX_DAYS

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
        staleDays: daysNumber,
        staleEmailEnabled: settings.staleEmailEnabled,
      })
      setSettings(updated)
      setDays(String(updated.staleDays))
      notify({ type: 'success', title: '设置已保存' })
    } catch (error) {
      notify({ type: 'error', title: '保存失败', message: String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <WarmCrmPage>
      <CrmRulesPanel onRefreshReady={registerRefreshOwner} />
      <CrmCategoryManager onRefreshReady={registerRefreshOwner} />

      <WarmCrmSection title="7 天无跟进提醒">
        <p className={styles.description}>
          客户/线索超过阈值天数无跟进时，自动给负责人发送提醒邮件
        </p>

        <div className={styles.form}>
          <div className={styles.settingRow}>
            <div>
              <span className={styles.settingLabel}>提醒邮件</span>
              <p>关闭后不再发送无跟进提醒邮件</p>
            </div>
            <SwitchPrimitive.Root
              checked={settings.staleEmailEnabled}
              onCheckedChange={(checked) =>
                setSettings({ ...settings, staleEmailEnabled: checked })
              }
              aria-label="提醒邮件开关"
              className={styles.switch}
            >
              <SwitchPrimitive.Thumb className={styles.switchThumb} />
            </SwitchPrimitive.Root>
          </div>

          <div className={styles.settingRow}>
            <div>
              <label className={styles.settingLabel} htmlFor="stale-days">
                无跟进天数
              </label>
              <p>超过该天数未跟进即触发提醒（默认 7 天）</p>
            </div>
            <div className={styles.daysField}>
              <input
                id="stale-days"
                type="number"
                min={MIN_DAYS}
                max={MAX_DAYS}
                className={styles.daysInput}
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
              <span>天</span>
            </div>
          </div>

          <div className={styles.footer}>
            <WarmButton
              variant="primary"
              onClick={save}
              disabled={saving || !daysValid}
              loading={saving}
            >
              {saving ? '保存中…' : '保存'}
            </WarmButton>
          </div>
        </div>
      </WarmCrmSection>
    </WarmCrmPage>
  )
}

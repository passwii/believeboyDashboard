'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications } from '@/components/notifications'
import {
  fetchAlertPreferences,
  updateAlertPreferences,
  type AlertPreference,
} from '@/lib/alerts-api'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import styles from '../alerts-warm.module.css'
import { AlertWarmSwitch } from './alert-warm-switch'

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
    return <div className={styles.loadingState}>加载中…</div>
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
    <section
      className={styles.preferencesPanel}
      data-warm-alert-preferences="true"
    >
      <div className={styles.preferenceRow}>
        <div>
          <span id="alert-email-label" className={styles.preferenceLabel}>邮件通知</span>
          <p className={styles.preferenceDescription}>告警触发时发送邮件</p>
        </div>
        <AlertWarmSwitch
          labelledBy="alert-email-label"
          checked={pref.email_enabled}
          onCheckedChange={(v) => updateDraft({ ...pref, email_enabled: v })}
        />
      </div>
      <div className={styles.preferenceRow}>
        <div>
          <span id="alert-in-app-label" className={styles.preferenceLabel}>站内通知</span>
          <p className={styles.preferenceDescription}>告警触发时写入通知中心（铃铛）</p>
        </div>
        <AlertWarmSwitch
          labelledBy="alert-in-app-label"
          checked={pref.in_app_enabled}
          onCheckedChange={(v) => updateDraft({ ...pref, in_app_enabled: v })}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="alert-min-severity" className={styles.preferenceLabel}>
          最低告警级别
        </label>
        <select
          id="alert-min-severity"
          value={pref.min_severity}
          onChange={(event) =>
            updateDraft({ ...pref, min_severity: event.target.value })
          }
          className={styles.severitySelect}
        >
          <option value="info">提示及以上</option>
          <option value="warning">警告及以上</option>
          <option value="critical">仅严重</option>
        </select>
      </div>
      <div className={styles.quietHoursGrid}>
        <div className={styles.field}>
          <label htmlFor="alert-quiet-start" className={styles.preferenceLabel}>
            免打扰开始
          </label>
          <input
            id="alert-quiet-start"
            type="time"
            className={styles.timeInput}
            value={pref.quiet_hours_start ?? ''}
            onChange={(e) => updateDraft({ ...pref, quiet_hours_start: e.target.value || null })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="alert-quiet-end" className={styles.preferenceLabel}>
            免打扰结束
          </label>
          <input
            id="alert-quiet-end"
            type="time"
            className={styles.timeInput}
            value={pref.quiet_hours_end ?? ''}
            onChange={(e) => updateDraft({ ...pref, quiet_hours_end: e.target.value || null })}
          />
        </div>
      </div>
      <WarmButton
        variant="primary"
        onClick={save}
        disabled={saving}
        loading={saving}
        loadingLabel="正在保存通知偏好"
      >
        {saving ? '保存中…' : '保存偏好'}
      </WarmButton>
    </section>
  )
}

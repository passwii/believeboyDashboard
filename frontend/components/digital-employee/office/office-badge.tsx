'use client'

import { useRouter } from 'next/navigation'
import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import type {
  OfficeEmployee,
  DisplayStatus,
} from '@/lib/digital-employee/office-stream-types'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

const WARM_STATUS: Record<
  DisplayStatus,
  { tone: WarmBadgeTone; label: string }
> = {
  WORKING: { tone: 'accent', label: '在岗' },
  PAUSING: { tone: 'accent', label: '收尾' },
  IDLE: { tone: 'neutral', label: '待命' },
  OFFLINE: { tone: 'neutral', label: '离线' },
  FAILED: { tone: 'negative', label: '失败' },
}

export function OfficeBadge({
  employee,
  presentation = false,
}: {
  employee: OfficeEmployee
  presentation?: boolean
}) {
  const router = useRouter()
  const {
    persona,
    work_item,
    display_status,
    busy_level,
    virtual_progress,
    step_label,
    queued_count,
    today_done,
    success_rate,
  } = employee
  const busy = busy_level === 'BUSY' || busy_level === 'SWAMPED'
  const failed = display_status === 'FAILED'
  const working = display_status === 'WORKING'
  const hero = work_item.project_name
    ? `【${work_item.project_name}】${work_item.report_label ?? ''}`
    : employee.current_task?.task_name ?? '暂无任务'
  const status = WARM_STATUS[display_status]
  const navigateToEmployee = () =>
    router.push(`/dashboard/ai/digital-employees/${employee.employee_id}`)

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="office-employee"
      data-employee-name={employee.name}
      data-office-card="warm"
      data-presentation={presentation ? 'true' : undefined}
      data-offline={display_status === 'OFFLINE' ? 'true' : undefined}
      data-failed={failed ? 'true' : undefined}
      data-busy={busy ? 'true' : undefined}
      onClick={navigateToEmployee}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        navigateToEmployee()
      }}
      className={`${styles.officeCard} ${presentation ? styles.officeCardPresentation : ''}`}
    >
      <div className={styles.officeCardHeader}>
        <div className={styles.officePerson}>
          <span
            className={styles.officeAvatar}
            data-status={display_status}
            aria-hidden="true"
          >
            {persona.emoji}
          </span>
          <div className={styles.officeIdentity}>
            <p className={styles.officeName}>{employee.name}</p>
            <p className={styles.officeTagline}>{persona.tagline}</p>
          </div>
        </div>
        <div className={styles.officeStatusGroup}>
          {busy ? <span className={styles.officeBusy}>忙碌</span> : null}
          <WarmBadge tone={status.tone}>{status.label}</WarmBadge>
        </div>
      </div>

      <div className={styles.officeHero}>
        <p className={styles.officeHeroLabel}>
          {working ? '正在处理' : failed ? '遇到问题' : '当前状态'}
        </p>
        <p className={styles.officeHeroText}>{hero}</p>
      </div>

      <div>
        <div className={styles.officeProgressTrack}>
          <div
            className={styles.officeProgressFill}
            style={{ width: `${Math.max(2, virtual_progress)}%` }}
          />
        </div>
        <p className={styles.officeStep}>{step_label}</p>
      </div>

      {employee.current_task ? (
        <div className={styles.officeDetails}>
          <p className={styles.officeDetailLine}>任务：{employee.current_task.task_name}</p>
          <p className={styles.officeDetailLine}>
            进度：{Math.round(virtual_progress)}% · 节奏：{employee.pace.toFixed(1)}x
          </p>
        </div>
      ) : null}

      <div className={styles.officeFooter}>
        <span>
          今日 {today_done} 件 · 成功率 {Math.round(success_rate * 100)}%
        </span>
        {queued_count > 0 ? (
          <span className={styles.officeQueued}>排队 {queued_count}</span>
        ) : null}
      </div>
    </div>
  )
}

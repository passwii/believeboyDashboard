'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { DashboardStats, LifecycleBoard } from '@/lib/crm/types'
import {
  WarmCrmPage,
  WarmCrmSection,
  WarmCrmState,
  WarmCrmTableScroller,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { FunnelChart } from '@/components/ui/funnel-chart'
import { SkeletonReveal } from '@/components/ui/skeleton-reveal'
import { buildLeadStageFunnel, leadConversionRate, leadFunnelStepRates } from '@/lib/crm/method/lead-funnel'
import { FunnelStageDrawer } from '@/components/crm/funnel-stage-drawer'
import { LifecycleBoardSection } from '@/components/crm/lifecycle-board'
import styles from './dashboard-warm.module.css'

/** 数字紧凑显示：12400 → "1.2万"，小数字原样。 */
const compact = (v: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(v)

/** 后端阶段 key → 展示名（与 LEAD_STATUS_LABELS 一致，BLF-516 决策 1）。 */
const STAGE_LABELS: Record<string, string> = {
  new: '新线索',
  contacting: '联系中',
  qualified: '已验证',
  converted: '已转化',
}

function areDashboardStatsEqual(current: DashboardStats, next: DashboardStats): boolean {
  const currentStageKeys = Object.keys(current.leadFunnel)
  const nextStageKeys = Object.keys(next.leadFunnel)

  return (
    currentStageKeys.length === nextStageKeys.length &&
    nextStageKeys.every((key) => current.leadFunnel[key] === next.leadFunnel[key]) &&
    current.newThisMonth.newCustomers === next.newThisMonth.newCustomers &&
    current.newThisMonth.newLeads === next.newThisMonth.newLeads &&
    current.newThisMonth.convertedCount === next.newThisMonth.convertedCount &&
    current.followActivity.followCount7d === next.followActivity.followCount7d &&
    current.perOwner.length === next.perOwner.length &&
    current.perOwner.every(
      (owner, index) =>
        owner.ownerId === next.perOwner[index]?.ownerId &&
        owner.ownerName === next.perOwner[index]?.ownerName &&
        owner.customerCount === next.perOwner[index]?.customerCount &&
        owner.convertedThisMonth === next.perOwner[index]?.convertedThisMonth
    )
  )
}

function KpiTile({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className={styles.kpiTile}>
      <span className={styles.kpiLabel}>{label}</span>
      <span
        className={accent ? `${styles.kpiValue} ${styles.kpiValueAccent}` : styles.kpiValue}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function DashboardKpiSkeleton() {
  return (
    <div className={styles.kpiGrid} aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className={styles.kpiTile}>
          <span className={styles.skeletonLabel} />
          <span className={styles.skeletonValue} />
        </div>
      ))}
    </div>
  )
}

function LeadFunnelSkeleton() {
  return (
    <div className={styles.funnelSkeleton} aria-hidden="true">
      <span className={styles.skeletonSummary} />
      <span className={styles.skeletonChart} />
      <div className={styles.stepGrid}>
        {Array.from({ length: 3 }, (_, index) => (
          <span key={index} className={styles.skeletonStep} />
        ))}
      </div>
    </div>
  )
}

export default function CrmDashboardPage() {
  const client = useCrmClient()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [lifecycle, setLifecycle] = useState<LifecycleBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, lifecycleRes] = await Promise.all([
        client.getDashboardStats(),
        client.getLifecycleBoard(),
      ])
      setStats((current) =>
        current && areDashboardStatsEqual(current, statsRes) ? current : statsRes
      )
      setLifecycle(lifecycleRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // 全局刷新继续接入 Top Header，页面内不再重复刷新按钮。
  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  // 漏斗阶段为各状态当前线索数，不累计；点击阶段打开复盘抽屉。
  const funnelStages = buildLeadStageFunnel(stats?.leadFunnel ?? {})
  const funnelTotal = funnelStages.reduce((sum, stage) => sum + stage.value, 0)
  const discarded = stats?.leadFunnel.discarded ?? 0
  const convRate = leadConversionRate(stats?.leadFunnel ?? {})

  return (
    <WarmCrmPage>
      {error ? (
        <WarmCrmState
          kind="error"
          title="加载失败"
          detail={error}
          action={<WarmButton onClick={() => void load()}>重试</WarmButton>}
        />
      ) : null}

      {stats !== null || loading ? (
        <SkeletonReveal
          loading={loading}
          skeleton={<DashboardKpiSkeleton />}
          data-testid="crm-dashboard-kpis"
        >
          {stats ? (
            <div className={styles.kpiGrid} aria-label="本月指标">
              <KpiTile label="本月新增客户" value={String(stats.newThisMonth.newCustomers)} accent />
              <KpiTile label="本月新增线索" value={String(stats.newThisMonth.newLeads)} />
              <KpiTile label="本月转化" value={String(stats.newThisMonth.convertedCount)} />
              <KpiTile label="近7天跟进" value={String(stats.followActivity.followCount7d)} />
            </div>
          ) : null}
        </SkeletonReveal>
      ) : null}

      {stats !== null || loading ? (
        <>
          <WarmCrmSection title="线索漏斗">
            <p className={styles.funnelDescription}>
              阶段口径为各阶段当前线索数；点击某级查看停留时长 / 卡点复盘明细。
            </p>
            <SkeletonReveal
              loading={loading}
              skeleton={<LeadFunnelSkeleton />}
              data-testid="crm-dashboard-funnel"
            >
              <div className={styles.funnelBody}>
                <div className={styles.funnelSummary}>
                  {convRate !== null ? (
                    <span className={styles.conversionRate}>
                      <TrendingUp aria-hidden="true" />
                      整体转化率 {(convRate * 100).toFixed(1)}%
                    </span>
                  ) : null}
                  {discarded > 0 ? (
                    <span className={styles.discarded}>本期弃置 {discarded}</span>
                  ) : null}
                </div>

                {funnelTotal > 0 ? (
                  <FunnelChart
                    data={funnelStages}
                    className={styles.funnelChart}
                    color="var(--warm-ledger-color-accent)"
                    edges="curved"
                    layers={2}
                    onStageClick={(index) => {
                      const stageKey = funnelStages[index]?.stage
                      if (stageKey) setSelectedStage(stageKey)
                    }}
                    orientation="horizontal"
                    formatValue={compact}
                  />
                ) : (
                  <WarmCrmState
                    className={styles.embeddedState}
                    kind="empty"
                    title="暂无漏斗数据"
                  />
                )}

                <div className={styles.stepGrid}>
                  {leadFunnelStepRates(funnelStages).map((rate, index) => {
                    const from = funnelStages[index]?.label ?? ''
                    const to = funnelStages[index + 1]?.label ?? ''
                    const pct = rate === null ? 0 : Math.round(rate * 100)
                    return (
                      <div key={`${from}-${to}`} className={styles.stepCard}>
                        <div className={styles.stepMeta}>
                          <span>
                            {from} → {to}
                          </span>
                          <span className={styles.stepValue}>
                            {rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
                          </span>
                        </div>
                        <div className={styles.stepTrack} aria-hidden="true">
                          <span style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </SkeletonReveal>
          </WarmCrmSection>

          <WarmCrmSection title="每销售业绩">
            {stats && stats.perOwner.length > 0 ? (
              <WarmCrmTableScroller ariaLabel="每销售业绩表格">
                <table>
                  <thead>
                    <tr>
                      <th>负责人</th>
                      <th data-numeric>名下客户数</th>
                      <th data-numeric>本月转化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.perOwner.map((owner) => (
                      <tr key={owner.ownerId}>
                        <td>{owner.ownerName ?? owner.ownerId}</td>
                        <td data-numeric>{owner.customerCount}</td>
                        <td data-numeric>{owner.convertedThisMonth}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </WarmCrmTableScroller>
            ) : (
              <WarmCrmState
                className={styles.embeddedState}
                kind={loading ? 'loading' : 'empty'}
                title={loading ? '加载中' : '暂无业绩数据'}
              />
            )}
          </WarmCrmSection>
        </>
      ) : null}

      {lifecycle !== null || loading ? (
        <LifecycleBoardSection board={lifecycle} loading={loading} />
      ) : null}

      <FunnelStageDrawer
        open={selectedStage !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedStage(null)
        }}
        stage={selectedStage ?? ''}
        stageLabel={selectedStage ? (STAGE_LABELS[selectedStage] ?? selectedStage) : ''}
      />
    </WarmCrmPage>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { DashboardStats, LifecycleBoard } from '@/lib/crm/types'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { ErrorState } from '@/components/ui/error-state'
import { FunnelChart } from '@/components/ui/funnel-chart'
import { buildLeadStageFunnel, leadConversionRate, leadFunnelStepRates } from '@/lib/crm/method/lead-funnel'
import { FunnelStageDrawer } from '@/components/crm/funnel-stage-drawer'
import { LifecycleBoardSection } from '@/components/crm/lifecycle-board'

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

/** BLF-837：KPI 终端磁贴（mono 数值 + 大写标签，portfolio-overview 同规格）。 */
function KpiTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'pos' | 'warn' | 'neg' | 'accent'
}) {
  const toneClass =
    tone === 'pos'
      ? 'text-term-pos'
      : tone === 'warn'
        ? 'text-term-warn'
        : tone === 'neg'
          ? 'text-term-neg'
          : tone === 'accent'
            ? 'text-term-accent'
            : 'text-term-text'
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border border-term-border bg-term-panel px-2 py-1.5">
      <span className="truncate font-mono text-xs uppercase tracking-wider text-term-muted">
        {label}
      </span>
      <span
        className={`truncate font-mono text-base leading-6 tabular-nums ${toneClass}`}
        title={value}
      >
        {value}
      </span>
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

  // —— BLF-837：全局刷新接入 Top Header（原页内刷新按钮移除，语义一致）——
  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  // 漏斗：阶段漏斗（raw counts，不累计）——BLF-516 决策 4：raw 宽度直接看出
  // 「哪一级堆了人、哪一级掉得快」，4 级粗粒度下不会忽宽忽窄。
  const funnelStages = buildLeadStageFunnel(stats?.leadFunnel ?? {})
  const funnelTotal = funnelStages.reduce((s, st) => s + st.value, 0)
  const discarded = stats?.leadFunnel.discarded ?? 0
  const convRate = leadConversionRate(stats?.leadFunnel ?? {})

  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载；刷新按钮上移 Header 右段
    <div className="flex min-w-0 flex-col gap-2">
      {error && (
        <ErrorState title="加载失败" message={error} onRetry={() => void load()} />
      )}

      {/* 本月新增 + 跟进活跃度：终端磁贴行 */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <KpiTile
          label="本月新增客户"
          value={String(stats?.newThisMonth.newCustomers ?? 0)}
          tone="accent"
        />
        <KpiTile
          label="本月新增线索"
          value={String(stats?.newThisMonth.newLeads ?? 0)}
          tone="warn"
        />
        <KpiTile
          label="本月转化"
          value={String(stats?.newThisMonth.convertedCount ?? 0)}
          tone="pos"
        />
        <KpiTile
          label="近7天跟进"
          value={String(stats?.followActivity.followCount7d ?? 0)}
        />
      </div>

      {/* 线索漏斗（阶段口径：各状态当前计数） */}
      <TermPanel bodyClassName="p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-xs uppercase tracking-wider text-term-muted">
            线索漏斗 · 阶段口径为各阶段当前线索数，点击某级查看停留时长 / 卡点复盘明细
          </h2>
          <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
            {convRate !== null && (
              <span className="inline-flex items-center gap-1 text-term-pos">
                <TrendingUp className="h-3.5 w-3.5" aria-hidden />
                整体转化率 {(convRate * 100).toFixed(1)}%
              </span>
            )}
            {discarded > 0 && (
              <span className="inline-flex items-center gap-1 text-term-muted">
                <span className="h-1 w-1 bg-term-faint" aria-hidden />
                本期弃置 {discarded}
              </span>
            )}
          </div>
        </div>
        {funnelTotal > 0 ? (
          <>
            <FunnelChart
              data={funnelStages}
              className="mx-auto w-full max-w-3xl"
              color="var(--chart-1)"
              edges="curved"
              layers={2}
              onStageClick={(i) => {
                const stageKey = funnelStages[i]?.stage
                if (stageKey) setSelectedStage(stageKey)
              }}
              orientation="horizontal"
              formatValue={compact}
            />
            {/* 逐级转化率：相邻阶段的流转效率，定位漏斗卡点 */}
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {leadFunnelStepRates(funnelStages).map((rate, i) => {
                const from = funnelStages[i]?.label ?? ''
                const to = funnelStages[i + 1]?.label ?? ''
                const pct = rate === null ? 0 : Math.round(rate * 100)
                return (
                  <div key={`${from}-${to}`} className="border border-term-border px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-term-muted">
                        {from} → {to}
                      </span>
                      <span className="font-mono tabular-nums text-term-text">
                        {rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden bg-term-raised">
                      <div
                        className={`h-full transition-[width] duration-500 ${rate !== null && rate < 0.5 ? 'bg-term-neg' : 'bg-term-pos'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <div className="flex h-[280px] items-center justify-center font-mono text-xs text-term-faint">
            {loading ? '加载中…' : '暂无漏斗数据'}
          </div>
        )}
      </TermPanel>

      {/* 每销售业绩：终端高密度表 */}
      <TermPanel title="每销售业绩" bodyClassName="overflow-auto">
        {stats && stats.perOwner.length > 0 ? (
          <TermTable>
            <TermTHead>
              <TermRow>
                <TermHead>负责人</TermHead>
                <TermHead numeric>名下客户数</TermHead>
                <TermHead numeric>本月转化</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {stats.perOwner.map((p) => (
                <TermRow key={p.ownerId}>
                  <TermCell>{p.ownerName ?? p.ownerId}</TermCell>
                  <TermCell numeric>{p.customerCount}</TermCell>
                  <TermCell numeric tone="pos">
                    {p.convertedThisMonth}
                  </TermCell>
                </TermRow>
              ))}
            </TermBody>
          </TermTable>
        ) : (
          <p className="py-6 text-center font-mono text-xs text-term-faint">
            {loading ? '加载中…' : '暂无业绩数据'}
          </p>
        )}
      </TermPanel>

      {/* 生命周期（P8，BLF-520）：创建 → 首次跟进/转化/流失 时间分布 */}
      <LifecycleBoardSection board={lifecycle} loading={loading} />

      {/* 漏斗二层复盘面板（BLF-518）：点击漏斗某级展开 */}
      <FunnelStageDrawer
        open={selectedStage !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedStage(null)
        }}
        stage={selectedStage ?? ''}
        stageLabel={selectedStage ? (STAGE_LABELS[selectedStage] ?? selectedStage) : ''}
      />
    </div>
  )
}

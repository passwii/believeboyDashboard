'use client'

import type { IntentStats } from '@/lib/crm/intent/types'
import type { IntentQueryState } from '@/lib/crm/intent/use-intent-filters'

import { IntentMetricPanel } from './intent-display'

import styles from '../intent-warm.module.css'

type IntentMetricsProps = {
  stats: IntentStats | null
  state: IntentQueryState
  patch: (patch: Partial<IntentQueryState>) => void
  resetFilters: () => void
}

function hasIntentFilters(state: IntentQueryState): boolean {
  return Boolean(
    state.level ||
      state.q.trim() ||
      state.category ||
      state.channel ||
      state.province ||
      state.city ||
      state.state ||
      state.withPhone ||
      state.dup ||
      state.due
  )
}

/**
 * 5 张 metric panel（统计口径全部来自服务端 meta.stats）：
 * 在库企业 / A 级 / B 级 / 已联系 / 待筛池。点击与筛选或 tab 联动。
 */
export function IntentMetrics({ stats, state, patch, resetFilters }: IntentMetricsProps) {
  const totalActive = state.tab === 'intent' && !hasIntentFilters(state)

  return (
    <div className={styles.metrics} data-intent-metrics>
      <IntentMetricPanel
        label="在库企业"
        onClick={() => {
          resetFilters()
          if (state.tab !== 'intent') patch({ tab: 'intent' })
        }}
        active={totalActive}
        primary
        value={stats?.total ?? null}
      />
      <IntentMetricPanel
        label="A 级 · 强意向"
        active={state.tab === 'intent' && state.level === 'A'}
        onClick={() => patch({ tab: 'intent', level: state.level === 'A' ? null : 'A' })}
        value={stats?.byLevel.A ?? null}
      />
      <IntentMetricPanel
        label="B 级 · 可培育"
        active={state.tab === 'intent' && state.level === 'B'}
        onClick={() => patch({ tab: 'intent', level: state.level === 'B' ? null : 'B' })}
        value={stats?.byLevel.B ?? null}
      />
      <IntentMetricPanel
        label="已联系"
        active={state.tab === 'board'}
        onClick={() => patch({ tab: 'board' })}
        value={stats?.contacted ?? null}
      />
      <IntentMetricPanel
        label="待筛池"
        active={state.tab === 'pool'}
        onClick={() => patch({ tab: 'pool' })}
        value={stats?.poolTotal ?? null}
      />
    </div>
  )
}

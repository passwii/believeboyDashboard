'use client'

import { Loader2 } from 'lucide-react'

import styles from '../insights-warm.module.css'
import { LEGACY_SUB_STATUS_LABELS } from './legacy-insight-compat'

const GENERATION_STEPS = [
  { key: 'data_aggregating', label: '聚合数据', description: '从数据库获取销售、广告、库存等数据' },
  { key: 'ai_generating', label: '生成洞察', description: 'AI 分析数据并生成洞察内容' },
  { key: 'title_generating', label: '生成标题', description: '为洞察报告生成标题' },
]

const DATA_STEPS = [
  { key: 'data_aggregating_sales', label: '销售数据' },
  { key: 'data_aggregating_ad', label: '广告数据' },
  { key: 'data_aggregating_inventory', label: '库存快照' },
  { key: 'data_aggregating_top_skus', label: 'Top SKU' },
  { key: 'data_aggregating_comparison_sales', label: '对比期销售' },
  { key: 'data_aggregating_comparison_ad', label: '对比期广告' },
  { key: 'data_aggregating_ad_campaigns', label: '广告活动' },
]

/** 旧洞察流的阶段步进器（兼容 adapter；只读 sub_status，不持有流状态）。 */
export function GenerationProgress({ currentSubStatus }: { currentSubStatus: string | null }) {
  const effectiveSubStatus = currentSubStatus === 'queued' ? 'data_aggregating' : currentSubStatus
  // Top-level step (data_aggregating, ai_generating, title_generating)
  const topLevelIndex = effectiveSubStatus
    ? GENERATION_STEPS.findIndex((s) => s.key === effectiveSubStatus)
    : -1

  // True when we're inside data aggregation sub-steps (e.g. data_aggregating_sales)
  const isInSubSteps =
    effectiveSubStatus?.startsWith('data_aggregating') && effectiveSubStatus !== 'data_aggregating'
  // The active sub-step index
  const activeSubStepIndex = effectiveSubStatus
    ? DATA_STEPS.findIndex((s) => s.key === effectiveSubStatus)
    : -1

  return (
    <div className={styles.progress}>
      {/* Status header */}
      {currentSubStatus && (
        <div className={styles.progressStatus} role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>
            {LEGACY_SUB_STATUS_LABELS[currentSubStatus] ?? '处理中...'}
          </span>
        </div>
      )}

      {/* Stepper */}
      <div className={styles.progressSteps}>
        {GENERATION_STEPS.map((step, index) => {
          const isActive = index === topLevelIndex
          // Completed if we've moved past this step, OR we've entered a sub-step of this step
          const isCompleted =
            index < topLevelIndex ||
            (topLevelIndex === index && isInSubSteps) ||
            (topLevelIndex === 1 && currentSubStatus === 'ai_generating' && index === 0)

          // Determine connector fill: step 1 needs topLevelIndex >= 1; step 2 needs >= 2
          const connectorFilled = index === 1 ? topLevelIndex >= 1 : topLevelIndex >= 2

          return (
            <div key={step.key} className={styles.progressStep}>
              <div className={styles.progressRail}>
                {index > 0 && (
                  <div
                    className={styles.progressConnector}
                    data-complete={connectorFilled}
                  />
                )}
                <div
                  className={styles.progressDot}
                  data-state={isCompleted ? 'complete' : isActive ? 'active' : 'pending'}
                >
                  {isCompleted ? (
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isActive ? (
                    isInSubSteps ? (
                      <span className="text-xs font-bold">{index + 1}</span>
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )
                  ) : (
                    <span className="text-xs font-medium">{index + 1}</span>
                  )}
                </div>
              </div>

              {/* Step content */}
              <div className={styles.progressCopy}>
                <p
                  className={styles.progressLabel}
                  data-state={isActive ? 'active' : isCompleted ? 'complete' : 'pending'}
                >
                  {step.label}
                </p>
                <p className={styles.progressDescription}>{step.description}</p>

                {/* Nested data sub-steps when in data_aggregating phase */}
                {step.key === 'data_aggregating' && (
                  <div className={styles.progressSubtasks}>
                    {DATA_STEPS.map((ds, di) => {
                      const isDCompleted = activeSubStepIndex > di || topLevelIndex > 0
                      const isDActive = effectiveSubStatus === ds.key

                      return (
                        <div
                          key={ds.key}
                          className={styles.progressSubtask}
                          data-state={
                            isDActive ? 'active' : isDCompleted ? 'complete' : 'pending'
                          }
                        >
                          <span className={styles.progressSubtaskDot} aria-hidden />
                          <span>{ds.label}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

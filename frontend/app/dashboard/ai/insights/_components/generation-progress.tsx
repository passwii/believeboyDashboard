'use client'

import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

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
    <div className="space-y-6">
      {/* Status header */}
      {currentSubStatus && (
        <div className="flex items-center gap-2 rounded-none border border-term-accent/40 bg-term-bg px-4 py-3">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-term-accent" />
          <span className="font-mono text-xs font-medium text-term-accent">
            {LEGACY_SUB_STATUS_LABELS[currentSubStatus] ?? '处理中...'}
          </span>
        </div>
      )}

      {/* Stepper */}
      <div className="space-y-0">
        {GENERATION_STEPS.map((step, index) => {
          const isActive = index === topLevelIndex
          // Completed if we've moved past this step, OR we've entered a sub-step of this step
          const isCompleted =
            index < topLevelIndex ||
            (topLevelIndex === index && isInSubSteps) ||
            (topLevelIndex === 1 && currentSubStatus === 'ai_generating' && index === 0)
          const isPending = !isActive && !isCompleted

          // Determine connector fill: step 1 needs topLevelIndex >= 1; step 2 needs >= 2
          const connectorFilled = index === 1 ? topLevelIndex >= 1 : topLevelIndex >= 2

          return (
            <div key={step.key} className="flex items-start gap-4">
              {/* Connector line */}
              {index > 0 && (
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      'w-0.5 h-4 transition-colors duration-500',
                      connectorFilled ? 'bg-term-accent' : 'bg-term-border'
                    )}
                  />
                </div>
              )}
              {index === 0 && <div className="w-5" />}

              {/* Step indicator */}
              <div className="relative flex flex-col items-center shrink-0">
                {/* Pulsing glow ring when this step is active (matches Loader2 spinner above) */}
                {isActive && !isInSubSteps && (
                  <div
                    className="absolute rounded-full bg-term-accent/30 animate-ping"
                    style={{ width: 20, height: 20, top: -7, left: -7 }}
                  />
                )}
                <div
                  className={cn(
                    'flex items-center justify-center rounded-full border transition-all duration-300',
                    isCompleted
                      ? 'border-term-pos bg-term-pos text-term-bg'
                      : isActive
                        ? 'border-term-accent bg-term-bg text-term-accent'
                        : 'border-term-border bg-term-bg text-term-faint',
                    isActive ? 'h-5 w-5' : 'h-5 w-5'
                  )}
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
              <div className="flex-1 pb-6">
                <p
                  className={cn(
                    'text-sm font-medium transition-colors duration-300',
                    isActive
                      ? 'text-term-accent'
                      : isCompleted
                        ? 'text-term-text'
                        : 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>

                {/* Nested data sub-steps when in data_aggregating phase */}
                {step.key === 'data_aggregating' && (
                  <div className="mt-2 space-y-1.5 border-l-2 border-term-border pl-2">
                    {DATA_STEPS.map((ds, di) => {
                      const isDCompleted = activeSubStepIndex > di || topLevelIndex > 0
                      const isDActive = effectiveSubStatus === ds.key
                      const detail = undefined

                      return (
                        <div
                          key={ds.key}
                          className={cn(
                            'flex flex-col gap-1 transition-all duration-300',
                            isDActive ? 'translate-x-1' : ''
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <div className="relative flex items-center justify-center w-3 h-3">
                              {/* Running dot for active step */}
                              {isDActive && (
                                <div className="absolute inset-0 rounded-full bg-term-accent/30 animate-ping" />
                              )}
                              <div
                                className={cn(
                                  'h-1.5 w-1.5 rounded-full transition-colors duration-300',
                                  isDActive
                                    ? 'bg-term-accent'
                                    : isDCompleted
                                      ? 'bg-term-pos'
                                      : 'bg-term-border'
                                )}
                              />
                            </div>
                            <span
                              className={cn(
                                'text-xs transition-colors duration-300',
                                isDActive
                                  ? 'text-term-accent font-semibold'
                                  : isDCompleted
                                    ? 'text-foreground'
                                    : 'text-muted-foreground'
                              )}
                            >
                              {ds.label}
                            </span>
                            {/* Animated indicator for active sub-step */}
                            {isDActive && (
                              <div className="ml-auto flex gap-0.5">
                                {[0, 1, 2].map((i) => (
                                  <div
                                    key={i}
                                    className="h-1 w-1 rounded-full bg-term-accent animate-bounce"
                                    style={{ animationDelay: `${i * 120}ms` }}
                                  />
                                ))}
                              </div>
                            )}
                          </div>

                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Animated dots for active top-level step (AI generating / title generating) */}
                {isActive && !isInSubSteps && (
                  <div className="flex gap-1 mt-2">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-term-accent animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Info note */}
      <p className="text-xs text-muted-foreground border-t pt-4">
        生成任务在后台运行，可以切换到其他页面，稍后再来查看结果。完成后可在下方查看完整的洞察报告。
      </p>
    </div>
  )
}

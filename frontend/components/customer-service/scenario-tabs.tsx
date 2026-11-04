'use client'
import type { ScenarioSummary } from '@/lib/server/ai-chat'
import styles from './customer-service-warm.module.css'

export function ScenarioTabs({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: ScenarioSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const activeScenario = scenarios.find((scenario) => scenario.id === selectedId)

  return (
    <div className={styles.scenarioBar}>
      <div className={styles.scenarioTabs} role="group" aria-label="客服场景">
        {scenarios.map((s) => {
          const active = s.id === selectedId
          return (
            <button
              key={s.id}
              type="button"
              disabled={s.disabled}
              onClick={() => !s.disabled && onSelect(s.id)}
              aria-pressed={active}
              className={styles.scenarioTab}
              title={s.disabled ? '即将上线' : s.description}
            >
              {s.label}
              {s.disabled ? '（即将上线）' : ''}
            </button>
          )
        })}
      </div>
      {activeScenario ? (
        <p className={styles.scenarioDescription}>
          {activeScenario.description}
        </p>
      ) : null}
    </div>
  )
}

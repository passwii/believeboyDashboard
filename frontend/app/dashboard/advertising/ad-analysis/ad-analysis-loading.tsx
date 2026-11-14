'use client'

import { usePathname } from 'next/navigation'

import styles from './ad-analysis-warm.module.css'

const TABLE_CELL_WIDTHS = ['w-1/2', 'w-3/4', 'w-2/3', 'w-1/3', 'w-3/5', 'w-1/2'] as const
const NARRATIVE_VIEWS = ['budget', 'campaigns', 'placements', 'search-terms', 'traffic-quality']

export function AdAnalysisWarmLoading() {
  const pathname = usePathname() || ''
  const isOverview =
    pathname.endsWith('/overview') || pathname.endsWith('/ad-analysis')
  const isTimeTrend = pathname.endsWith('/time-trend')
  const isPurchasedProducts = pathname.endsWith('/purchased-products')
  const hasNarrative = NARRATIVE_VIEWS.some((view) => pathname.endsWith(`/${view}`))
  const metricCount = isOverview ? 8 : isTimeTrend ? 3 : isPurchasedProducts ? 0 : 4

  return (
    <div className={styles.loading} data-warm-ad-analysis-loading="true" aria-busy="true">
      <div
        role="status"
        aria-live="polite"
        className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]"
      >
        正在加载广告分析…
      </div>
      {metricCount > 0 ? (
        <div
          className={styles.loadingGrid}
          style={{ gridTemplateColumns: `repeat(${metricCount}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {Array.from({ length: metricCount }).map((_, index) => (
            <div key={index} className={styles.loadingTile}>
              <div className="space-y-2 p-3">
                <div className="h-3 w-1/3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
                <div className="h-5 w-2/3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {isOverview ? (
        <div className="grid grid-cols-1 gap-2 sm:h-[38vh] sm:min-h-[220px] sm:max-h-[420px] sm:grid-cols-2" aria-hidden="true">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="flex h-[220px] min-h-0 flex-col overflow-hidden rounded-[var(--warm-ledger-radius-panel)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] sm:h-auto"
            >
              <div className="h-11 shrink-0 border-b border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)]" />
              <div className="grid flex-1 grid-rows-4 px-3 py-2">
                {Array.from({ length: 4 }).map((_, lineIndex) => (
                  <div
                    key={lineIndex}
                    className="border-b border-[var(--warm-ledger-color-hairline)]"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : hasNarrative ? (
        <div
          className="grid min-h-[128px] content-start gap-3 rounded-[var(--warm-ledger-radius-panel)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] p-4"
          aria-hidden="true"
        >
          <div className="h-3 w-1/4 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
          <div className="h-3 w-5/6 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
          <div className="h-3 w-2/3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
        </div>
      ) : null}

      <div className={`${styles.loadingPanel} overflow-hidden`} aria-hidden="true">
        <div className="flex h-11 items-center border-b border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3">
          <div className="h-3 w-1/4 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)]" />
        </div>
        <div className="grid gap-px bg-[var(--warm-ledger-color-hairline)] p-px">
          <div className="grid h-11 grid-cols-6 items-center gap-4 bg-[var(--warm-ledger-color-panel-strong)] px-3">
            {TABLE_CELL_WIDTHS.map((width, cellIndex) => (
              <div
                key={cellIndex}
                className={`h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)] ${width}`}
              />
            ))}
          </div>
          {Array.from({ length: 9 }).map((_, rowIndex) => (
            <div
              key={rowIndex}
              className="grid h-[38px] grid-cols-6 items-center gap-4 bg-[var(--warm-ledger-color-panel)] px-3"
            >
              {TABLE_CELL_WIDTHS.map((width, cellIndex) => (
                <div
                  key={cellIndex}
                  className={`h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)] ${width}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

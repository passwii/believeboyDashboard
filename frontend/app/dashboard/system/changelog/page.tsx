'use client'

import { useState } from 'react'
import { ArrowUpRight, ChevronDown, Layers3, Waypoints } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { getChangelogSnapshot, type ReleaseVersion } from '@/lib/server/changelog'
import styles from './changelog-warm.module.css'

function formatDateLabel(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatDateRange(release: ReleaseVersion): string {
  if (!release.endDate || release.status === 'current') {
    return `${formatDateLabel(release.startDate)} - 至今`
  }

  return `${formatDateLabel(release.startDate)} - ${formatDateLabel(release.endDate)}`
}

function SourceLogsSection({
  logs,
  releaseVersion,
}: {
  logs: string[]
  releaseVersion: string
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (logs.length === 0) return null

  const panelId = `source-logs-${releaseVersion.toLowerCase()}`

  return (
    <section className={styles.sourceLogs}>
      <button
        type="button"
        className={styles.sourceLogsToggle}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        onClick={() => setIsExpanded((expanded) => !expanded)}
      >
        <Waypoints className={styles.sourceLogsIcon} aria-hidden="true" />
        <span>原始 log 线索</span>
        <WarmBadge tone="neutral">{logs.length}</WarmBadge>
        <ChevronDown
          className={styles.sourceLogsChevron}
          data-expanded={isExpanded}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} className={styles.sourceLogsBody} hidden={!isExpanded}>
        <ul className={styles.sourceLogList}>
          {logs.map((log) => (
            <li key={log}>
              <span className={styles.sourceLogMarker} aria-hidden="true" />
              <span>{log}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function ReleaseMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.releaseMetric}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

export default function ChangelogPage() {
  const snapshot = getChangelogSnapshot()
  const releasesDesc = [...snapshot.releases].reverse()

  return (
    <div className={styles.page} data-warm-changelog="true">
      <div className={styles.layout}>
        <aside className={styles.navigationColumn}>
          <section className={styles.navigationPanel} aria-label="版本导航">
            <header className={styles.panelHeader}>
              <h2>版本导航</h2>
            </header>
            <div className={styles.navigationBody}>
              <p className={styles.navigationHint}>
                按大版本查看关键能力建设与原始变更线索。
              </p>
              <nav
                className={styles.releaseNavigation}
                aria-label="Changelog release navigation"
              >
                {releasesDesc.map((release) => (
                  <a
                    key={release.version}
                    href={`#${release.version.toLowerCase()}`}
                    className={styles.releaseNavItem}
                    data-release-status={release.status}
                  >
                    <span className={styles.releaseNavCopy}>
                      <span className={styles.releaseNavVersion}>{release.version}</span>
                      <span className={styles.releaseNavName}>{release.codename}</span>
                      <span className={styles.releaseNavDate}>
                        {formatDateRange(release)}
                      </span>
                    </span>
                    <ArrowUpRight
                      className={styles.releaseNavArrow}
                      aria-hidden="true"
                    />
                  </a>
                ))}
              </nav>
            </div>
          </section>
        </aside>

        <div className={styles.releaseList}>
          {releasesDesc.map((release) => {
            const headingId = `release-title-${release.version.toLowerCase()}`

            return (
              <section
                key={release.version}
                id={release.version.toLowerCase()}
                className={styles.releaseSection}
                aria-labelledby={headingId}
              >
                <article className={styles.releasePanel}>
                  <header className={styles.releaseHeader}>
                    <div className={styles.releaseIntro}>
                      <div className={styles.releaseTitleRow}>
                        <h2 id={headingId} className={styles.releaseVersion}>
                          {release.version}
                        </h2>
                        <span className={styles.releaseCodename}>{release.codename}</span>
                        <span className={styles.releaseDate}>
                          {formatDateRange(release)}
                        </span>
                      </div>
                      <p className={styles.releaseSummary}>{release.summary}</p>
                    </div>

                    <dl className={styles.releaseMetrics}>
                      <ReleaseMetric label="模块" value={release.focus.length} />
                      <ReleaseMetric label="亮点" value={release.highlights.length} />
                      <ReleaseMetric label="线索" value={release.sourceLogs.length} />
                    </dl>
                  </header>

                  <div className={styles.releaseBody}>
                    <div className={styles.focusList} aria-label="版本关注模块">
                      {release.focus.map((item) => (
                        <WarmBadge key={item} tone="neutral">
                          {item}
                        </WarmBadge>
                      ))}
                    </div>

                    <div className={styles.highlightGrid}>
                      {release.highlights.map((highlight) => (
                        <article
                          key={`${release.version}-${highlight.title}`}
                          className={styles.highlightCard}
                        >
                          <span className={styles.highlightIcon} aria-hidden="true">
                            <Layers3 />
                          </span>
                          <div className={styles.highlightCopy}>
                            <span className={styles.highlightArea}>{highlight.area}</span>
                            <h3>{highlight.title}</h3>
                            <p>{highlight.detail}</p>
                          </div>
                        </article>
                      ))}
                    </div>

                    <div className={styles.releaseFooter}>
                      <SourceLogsSection
                        logs={release.sourceLogs}
                        releaseVersion={release.version}
                      />

                      <section className={styles.positioning}>
                        <h3>版本定位</h3>
                        <p>
                          {release.version} 主要聚焦{' '}
                          <strong>{release.focus.slice(0, 2).join('、')}</strong>
                          ，并向{' '}
                          <strong>
                            {release.focus.slice(2).join('、') || '相关体验优化'}
                          </strong>{' '}
                          延展，代表这一阶段最完整的一次能力打包。
                        </p>
                      </section>
                    </div>
                  </div>
                </article>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

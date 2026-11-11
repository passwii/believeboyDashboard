'use client'

import { useCallback, useEffect, useState } from 'react'
import { Monitor, RefreshCw, X } from 'lucide-react'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { forceDarkDocument } from '@/lib/forced-dark'
import { fetchProjectOptionsCached } from '@/lib/project-client-cache'

import styles from './digital-display-warm.module.css'
import { WarmTrendChart } from './warm-trend-chart'

interface SalesTrendItem {
  date: string
  order_qty: number
  sales_amount: number
  sessions: number
}

interface DisplayData {
  project_id: number
  project_name: string
  country: string
  server_time: string
  sales: {
    today_order_qty: number
    today_sales_amount: number
    today_sessions: number
    today_ordered_sales_amount: number
    prev_order_qty: number
    prev_sales_amount: number
    prev_sessions: number
  }
  sales_trend: SalesTrendItem[]
  inventory: {
    sku_count: number
    out_of_stock_count: number
    available_qty: number
  }
  shipments: {
    in_transit_count: number
    in_transit_qty: number
  }
  returns: {
    total_returns: number
    total_quantity: number
    return_rate: number
    top_reason: string | null
  }
  ads: {
    period_spend: number
    period_sales: number
    period_roas: number
    period_acos: number
    period_ctr: number
    period_impressions: number
    period_clicks: number
    period_orders: number
  }
}

interface Project {
  id: number
  project_name: string
}

function fmtMoney(v: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v)
}

function fmtNum(v: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
}

function fmtRate(v: number) {
  return `${v.toFixed(1)}%`
}

function changeColor(current: number, prev: number) {
  if (prev === 0) return styles.accent
  return ((current - prev) / prev) * 100 >= 0 ? styles.positive : styles.negative
}

function changeArrow(current: number, prev: number) {
  if (prev === 0) return ''
  return ((current - prev) / prev) * 100 >= 0 ? '↑' : '↓'
}

function changePct(current: number, prev: number) {
  if (prev === 0) return ''
  const pct = ((current - prev) / prev) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  change,
  big = false,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
  change?: string
  big?: boolean
}) {
  return (
    <article className={`${styles.card} ${styles.kpiCard} ${big ? styles.bigKpi : ''}`}>
      <p className={`${styles.kpiValue} ${accent ?? ''}`}>{value}</p>
      <p className={styles.kpiLabel}>{label}</p>
      {sub ? <p className={styles.kpiSub}>{sub}</p> : null}
      {change ? <p className={styles.kpiChange}>{change}</p> : null}
    </article>
  )
}

const POLL_INTERVAL = 30000

export default function DigitalDisplayPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [displayData, setDisplayData] = useState<DisplayData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [now, setNow] = useState(new Date())
  const [secondsLeft, setSecondsLeft] = useState(POLL_INTERVAL / 1000)

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const restoreDocumentTheme = forceDarkDocument()
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
    const ticker = setInterval(() => setNow(new Date()), 1000)
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitFullscreen()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      restoreDocumentTheme()
      clearInterval(ticker)
    }
  }, [exitFullscreen])

  useEffect(() => {
    const saved = localStorage.getItem('digital-display-project')
    fetchProjectOptionsCached<{ items?: Project[] }>()
      .then((data) => {
        const items = data?.items ?? []
        setProjects(items)
        if (saved) {
          const found = items.find((project) => String(project.id) === saved)
          if (found) setSelectedProjectId(found.id)
        }
        setSelectedProjectId((current) => current ?? items[0]?.id ?? null)
      })
      .catch(() => {})
  }, [])

  const fetchData = useCallback(async (projectId: number) => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams({ country: 'US', days: '7' })
      const res = await fetch(`/api/backend/api/v1/digital-display/${projectId}?${params}`, {
        cache: 'no-store',
      })
      if (res.ok) {
        const data: DisplayData = await res.json()
        setDisplayData(data)
        setSecondsLeft(POLL_INTERVAL / 1000)
      }
    } catch {
      // Keep the last successful display snapshot.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedProjectId) return
    void fetchData(selectedProjectId)
    const pollTimer = setInterval(() => {
      void fetchData(selectedProjectId)
    }, POLL_INTERVAL)
    return () => clearInterval(pollTimer)
  }, [fetchData, selectedProjectId])

  useEffect(() => {
    const ticker = setInterval(() => {
      setSecondsLeft((seconds) => (seconds <= 1 ? POLL_INTERVAL / 1000 : seconds - 1))
    }, 1000)
    return () => clearInterval(ticker)
  }, [])

  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const refreshDisplay = useCallback(async () => {
    if (selectedProjectId) await fetchData(selectedProjectId)
  }, [fetchData, selectedProjectId])
  useHeaderRefresh(refreshDisplay, { loading: isLoading })

  return (
    <main
      className={`${styles.page} warm-ledger`}
      data-digital-display-exception="true"
      data-warm-surface="warm-ledger"
    >
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Monitor aria-hidden />
          </span>
          <div>
            <h1 className={styles.title}>{displayData?.project_name ?? '数字大屏'}</h1>
            <p className={styles.clock}>
              {now.toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' })}
            </p>
          </div>
        </div>

        <div className={styles.controls}>
          <select
            className={styles.select}
            aria-label="选择项目"
            value={selectedProjectId ?? ''}
            onChange={(event) => {
              const id = Number(event.target.value)
              setSelectedProjectId(id)
              localStorage.setItem('digital-display-project', String(id))
            }}
          >
            {projects.length === 0 ? <option value="">选择项目</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.project_name}
              </option>
            ))}
          </select>

          <div className={styles.countdown}>
            <RefreshCw aria-hidden className={isLoading ? styles.spinning : undefined} />
            <span>{secondsLeft}s</span>
          </div>

          <button
            type="button"
            className={styles.button}
            onClick={() => selectedProjectId && void fetchData(selectedProjectId)}
          >
            <RefreshCw aria-hidden />
            刷新
          </button>

          <button type="button" className={styles.button} onClick={exitFullscreen}>
            <X aria-hidden />
            退出全屏
          </button>
        </div>
      </header>

      {isLoading && !displayData ? (
        <div className={styles.loading} role="status" aria-label="正在加载数字大屏数据">
          <div className={styles.loadingInner}>
            <RefreshCw aria-hidden />
            <p>加载数据中...</p>
          </div>
        </div>
      ) : null}

      {displayData ? (
        <>
          <section className={styles.kpiGrid} aria-label="销售核心指标">
            <KpiCard
              label="今日订单量"
              value={fmtNum(displayData.sales.today_order_qty)}
              change={changePct(
                displayData.sales.today_order_qty,
                displayData.sales.prev_order_qty
              )}
              accent={changeColor(
                displayData.sales.today_order_qty,
                displayData.sales.prev_order_qty
              )}
            />
            <KpiCard
              label="今日销售额"
              value={fmtMoney(displayData.sales.today_sales_amount)}
              sub={
                changeArrow(
                  displayData.sales.today_sales_amount,
                  displayData.sales.prev_sales_amount
                ) +
                ' ' +
                changePct(
                  displayData.sales.today_sales_amount,
                  displayData.sales.prev_sales_amount
                )
              }
              accent={styles.positive}
              big
            />
            <KpiCard
              label="今日会话"
              value={fmtNum(displayData.sales.today_sessions)}
              change={changePct(displayData.sales.today_sessions, displayData.sales.prev_sessions)}
              accent={changeColor(
                displayData.sales.today_sessions,
                displayData.sales.prev_sessions
              )}
            />
            <KpiCard
              label="7日退货率"
              value={fmtRate(displayData.returns.return_rate)}
              sub={displayData.returns.top_reason ?? undefined}
              accent={
                displayData.returns.return_rate > 5 ? styles.negative : styles.positive
              }
            />
          </section>

          <section className={styles.chartCard} aria-label="7日销售趋势">
            <h2 className={styles.chartTitle}>7日销售趋势</h2>
            <WarmTrendChart
              data={displayData.sales_trend as unknown as Array<Record<string, unknown>>}
              xKey="date"
              config={{
                sales_amount: {
                  label: '销售额',
                  color: 'var(--warm-ledger-color-accent)',
                },
                order_qty: {
                  label: '订单量',
                  color: 'var(--warm-ledger-color-text-soft)',
                },
              }}
              yTickFormatter={fmtNum}
              tooltipFormatter={(value, name) => {
                const numValue = Number(value)
                return name === 'sales_amount' ? fmtMoney(numValue) : fmtNum(numValue)
              }}
              series={[
                { dataKey: 'sales_amount', name: '销售额' },
                { dataKey: 'order_qty', name: '订单量' },
              ]}
            />
          </section>

          <section className={styles.detailGrid} aria-label="库存、发货、退货与广告">
            <article className={`${styles.card} ${styles.detailCard}`}>
              <h2 className={styles.chartTitle}>库存概况</h2>
              <div className={styles.detailCenter}>
                <p className={styles.detailValue}>{fmtNum(displayData.inventory.sku_count)}</p>
                <p className={styles.detailLabel}>在售 SKU</p>
              </div>
              <div className={styles.miniGrid}>
                <div className={styles.miniCard}>
                  <p className={`${styles.miniValue} ${styles.negative}`}>
                    {displayData.inventory.out_of_stock_count}
                  </p>
                  <p className={styles.miniLabel}>缺货</p>
                </div>
                <div className={styles.miniCard}>
                  <p className={`${styles.miniValue} ${styles.accent}`}>
                    {fmtNum(displayData.inventory.available_qty)}
                  </p>
                  <p className={styles.miniLabel}>总库存</p>
                </div>
              </div>
            </article>

            <article className={`${styles.card} ${styles.detailCard}`}>
              <h2 className={styles.chartTitle}>发货在途</h2>
              <div className={styles.detailCenter}>
                <p className={`${styles.detailValue} ${styles.accent}`}>
                  {displayData.shipments.in_transit_count}
                </p>
                <p className={styles.detailLabel}>在途批次</p>
              </div>
              <div className={styles.miniCard}>
                <p className={styles.miniValue}>{fmtNum(displayData.shipments.in_transit_qty)}</p>
                <p className={styles.miniLabel}>在途总量</p>
              </div>
            </article>

            <article className={`${styles.card} ${styles.detailCard}`}>
              <h2 className={styles.chartTitle}>退货概况</h2>
              <div className={styles.detailCenter}>
                <p
                  className={`${styles.detailValue} ${
                    displayData.returns.return_rate > 5 ? styles.negative : styles.positive
                  }`}
                >
                  {fmtRate(displayData.returns.return_rate)}
                </p>
                <p className={styles.detailLabel}>退货率</p>
              </div>
              <div className={styles.miniGrid}>
                <div className={styles.miniCard}>
                  <p className={styles.miniValue}>{displayData.returns.total_returns}</p>
                  <p className={styles.miniLabel}>退货单数</p>
                </div>
                <div className={styles.miniCard}>
                  <p className={styles.miniValue}>{displayData.returns.total_quantity}</p>
                  <p className={styles.miniLabel}>退货件数</p>
                </div>
              </div>
              {displayData.returns.top_reason ? (
                <p className={styles.reason}>最高原因：{displayData.returns.top_reason}</p>
              ) : null}
            </article>

            <article className={`${styles.card} ${styles.detailCard}`}>
              <h2 className={styles.chartTitle}>广告数据</h2>
              <div className={styles.miniGridThree}>
                <div className={styles.miniCard}>
                  <p className={styles.miniValue}>{fmtMoney(displayData.ads.period_spend)}</p>
                  <p className={styles.miniLabel}>花费</p>
                </div>
                <div className={styles.miniCard}>
                  <p className={`${styles.miniValue} ${styles.positive}`}>
                    {displayData.ads.period_roas}x
                  </p>
                  <p className={styles.miniLabel}>ROAS</p>
                </div>
                <div className={styles.miniCard}>
                  <p
                    className={`${styles.miniValue} ${
                      displayData.ads.period_acos > 30 ? styles.negative : ''
                    }`}
                  >
                    {displayData.ads.period_acos}%
                  </p>
                  <p className={styles.miniLabel}>ACOS</p>
                </div>
              </div>
              <div className={`${styles.miniGridThree} mt-2`}>
                <div className={styles.miniCard}>
                  <p className={styles.miniValue}>{fmtNum(displayData.ads.period_impressions)}</p>
                  <p className={styles.miniLabel}>展示</p>
                </div>
                <div className={styles.miniCard}>
                  <p className={styles.miniValue}>{fmtNum(displayData.ads.period_clicks)}</p>
                  <p className={styles.miniLabel}>点击</p>
                </div>
                <div className={styles.miniCard}>
                  <p className={`${styles.miniValue} ${styles.accent}`}>
                    {displayData.ads.period_ctr}%
                  </p>
                  <p className={styles.miniLabel}>CTR</p>
                </div>
              </div>
            </article>
          </section>
        </>
      ) : null}
    </main>
  )
}

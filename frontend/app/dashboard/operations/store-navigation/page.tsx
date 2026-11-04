'use client'

import { ArrowUpRight, Building2, ExternalLink, Store } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

import styles from './store-navigation-warm.module.css'

type StoreItem = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
}

function StoreGrid({ items }: { items: StoreItem[] }) {
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        <Store aria-hidden />
        <p>暂无店铺数据</p>
      </div>
    )
  }

  return (
    <div className={styles.grid}>
      {items.map((store) => (
        <a
          key={store.id}
          href={store.store_address || '#'}
          target="_blank"
          rel="noreferrer"
          className={styles.card}
          onClick={(event) => {
            if (!store.store_address) event.preventDefault()
          }}
        >
          <div className={styles.cardTop}>
            <div className={styles.cardCopy}>
              <h3 className={styles.cardTitle}>{store.name}</h3>
              {store.brand_name ? (
                <p className={styles.meta}>
                  <Building2 aria-hidden />
                  {store.brand_name}
                </p>
              ) : null}
            </div>
            <span className={styles.openMark}>
              <ArrowUpRight aria-hidden />
            </span>
          </div>

          <p className={styles.address}>
            {store.store_address ? '点击访问店铺页面' : '暂无店铺链接'}
          </p>

          <div className={styles.cardFooter}>
            <span className={styles.linkLabel}>
              <ExternalLink aria-hidden />
              店铺链接
            </span>
            <span>点击直达</span>
          </div>
        </a>
      ))}
    </div>
  )
}

export default function StoreNavigationPage() {
  const { data: session, status } = useSession()
  const [stores, setStores] = useState<StoreItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStores = useCallback(
    async (force = false) => {
      try {
        setLoading(true)
        setError(null)
        const data = await fetchManagedProjectsCached<StoreItem[]>(session, undefined, { force })
        setStores(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : '未知错误')
      } finally {
        setLoading(false)
      }
    },
    [session]
  )

  useEffect(() => {
    if (status === 'loading') return
    void fetchStores()
  }, [status, fetchStores])

  const fetchStoresRef = useRef(fetchStores)
  fetchStoresRef.current = fetchStores
  useHeaderRefresh(() => void fetchStoresRef.current(true), { loading })

  const stats = [
    { label: '店铺总数', value: `${stores.length}` },
    { label: '有链接店铺', value: `${stores.filter((store) => store.store_address).length}` },
    {
      label: '品牌数量',
      value: `${new Set(stores.map((store) => store.brand_name).filter(Boolean)).size}`,
    },
  ]

  return (
    <main
      className={styles.page}
      data-testid="store-navigation-warm-page"
      data-warm-surface="warm-ledger"
    >
      <section className={styles.hero}>
        <div>
          <h2 className={styles.heroTitle}>店铺导航</h2>
          <p className={styles.heroCopy}>
            聚合团队所有店铺入口，可视化书签卡片，方便一键直达各店铺后台与前台页面。
          </p>
        </div>
        <div className={styles.stats}>
          {stats.map((item) => (
            <div key={item.label} className={styles.stat}>
              <span className={styles.statLabel}>{item.label}</span>
              <span className={styles.statValue}>{item.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>全部店铺</h2>
          <span>点击卡片直达店铺 · {stores.length} 项</span>
        </div>

        {loading ? (
          <div className={styles.loadingGrid} aria-busy="true" aria-label="正在加载店铺">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className={styles.skeleton} />
            ))}
          </div>
        ) : error ? (
          <div className={styles.error} role="alert">
            <div>
              <strong>加载失败</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => void fetchStores()}>
              重试
            </button>
          </div>
        ) : (
          <StoreGrid items={stores} />
        )}
      </section>
    </main>
  )
}

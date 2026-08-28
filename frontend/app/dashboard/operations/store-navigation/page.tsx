'use client'

import { ArrowUpRight, Building2, ExternalLink, Store } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { ErrorState } from '@/components/ui/error-state'
import { CardListSkeleton } from '@/components/dashboard/page-skeletons'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

type StoreItem = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
}

type StoreGridProps = {
  items: StoreItem[]
}

function StoreGrid({ items }: StoreGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center border border-dashed border-term-border bg-term-panel px-6 py-12 text-center">
        <Store className="mb-3 h-8 w-8 text-term-faint" />
        <p className="font-mono text-xs text-term-muted">暂无店铺数据</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-px bg-term-border p-px sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
      {items.map((store) => (
        <a
          key={store.id}
          href={store.store_address || '#'}
          target="_blank"
          rel="noreferrer"
          className="group flex h-full min-h-[132px] flex-col gap-2 border-0 bg-term-panel p-3 transition-colors hover:bg-term-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-border-strong"
          onClick={(e) => {
            if (!store.store_address) {
              e.preventDefault()
            }
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-term-text">{store.name}</h3>
              {store.brand_name && (
                <p className="mt-1 inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[11px] leading-4 text-term-muted">
                  <Building2 className="h-3 w-3 shrink-0" />
                  {store.brand_name}
                </p>
              )}
            </div>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-term-border bg-term-bg text-term-muted transition-colors group-hover:border-term-border-strong group-hover:text-term-text">
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
          </div>

          <p className="flex-1 font-mono text-[11px] leading-4 text-term-muted">
            {store.store_address ? '点击访问店铺页面' : '暂无店铺链接'}
          </p>

          <div className="flex items-center justify-between border-t border-term-border pt-2">
            <span className="inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[11px] leading-4 text-term-muted">
              <ExternalLink className="h-3 w-3" />
              店铺链接
            </span>
            <span className="font-mono text-[11px] leading-4 text-term-faint group-hover:text-term-muted">
              点击直达
            </span>
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

  // —— Header 化：全局刷新 = force 跳缓存重拉店铺列表（operations header 迁移 Batch C）——
  // 本页无筛选控件可上移，仅注册刷新回调；ref 桥接防过期闭包，loading 上报头部按钮。
  const fetchStoresRef = useRef(fetchStores)
  fetchStoresRef.current = fetchStores
  useHeaderRefresh(() => void fetchStoresRef.current(true), { loading })

  const stats = [
    { label: '店铺总数', value: `${stores.length}` },
    {
      label: '有链接店铺',
      value: `${stores.filter((s) => s.store_address).length}`,
    },
    {
      label: '品牌数量',
      value: `${new Set(stores.map((s) => s.brand_name).filter(Boolean)).size}`,
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TermPanel title="店铺导航" bodyClassName="p-3">
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-term-muted">
            聚合团队所有店铺入口，可视化书签卡片，方便一键直达各店铺后台与前台页面。
          </p>
          <div className="grid w-full max-w-sm grid-cols-3 gap-2">
            {stats.map((item) => (
              <TermKpiTile key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        </div>
      </TermPanel>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
            全部店铺
          </h2>
          <span className="font-mono text-[11px] text-term-faint">
            点击卡片直达店铺 · {stores.length} 项
          </span>
        </div>

        {loading ? (
          <CardListSkeleton count={6} />
        ) : error ? (
          <ErrorState title="加载失败" message={error} onRetry={() => void fetchStores()} />
        ) : (
          <StoreGrid items={stores} />
        )}
      </section>
    </div>
  )
}

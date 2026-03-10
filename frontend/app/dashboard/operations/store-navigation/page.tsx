'use client'

import { ArrowUpRight, Building2, ExternalLink, Loader2, Store } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

type StoreItem = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
}

const tonePresets = [
  'from-[#3b82f6]/25 via-[#60a5fa]/10 to-transparent',
  'from-[#10b981]/25 via-[#34d399]/10 to-transparent',
  'from-[#f59e0b]/25 via-[#fbbf24]/10 to-transparent',
  'from-[#ef4444]/25 via-[#f87171]/10 to-transparent',
  'from-[#8b5cf6]/25 via-[#a78bfa]/10 to-transparent',
  'from-[#ec4899]/25 via-[#f472b6]/10 to-transparent',
  'from-[#06b6d4]/25 via-[#22d3ee]/10 to-transparent',
  'from-[#84cc16]/25 via-[#a3e635]/10 to-transparent',
]

function getToneByIndex(index: number): string {
  return tonePresets[index % tonePresets.length]
}

type StoreGridProps = {
  items: StoreItem[]
}

function StoreGrid({ items }: StoreGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-border/70 bg-card p-12 text-center">
        <Store className="mb-4 h-12 w-12 text-muted-foreground/50" />
        <p className="text-muted-foreground">暂无店铺数据</p>
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
      {items.map((store, index) => (
        <a
          key={store.id}
          href={store.store_address || '#'}
          target="_blank"
          rel="noreferrer"
          className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card p-4 shadow-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:border-primary/35 hover:shadow-xl hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
          style={{ animationDelay: `${index * 40}ms` }}
          onClick={(e) => {
            if (!store.store_address) {
              e.preventDefault()
            }
          }}
        >
          <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${getToneByIndex(index)}`} />
          <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/20 blur-2xl dark:bg-white/5" />
          <div className="relative z-10 flex h-full flex-col space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{store.name}</h2>
                {store.brand_name && (
                  <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                    <Building2 className="h-3 w-3" />
                    {store.brand_name}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border/70 bg-background/75 p-2 text-muted-foreground transition-colors group-hover:text-primary">
                <ArrowUpRight className="h-4 w-4" />
              </div>
            </div>

            <p className="min-h-12 flex-1 text-sm leading-6 text-muted-foreground">
              {store.store_address ? '点击访问店铺页面' : '暂无店铺链接'}
            </p>

            <div className="mt-auto flex items-center justify-between border-t border-border/70 pt-3">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2.5 py-1 text-xs text-foreground/85">
                <ExternalLink className="h-3 w-3" />
                店铺链接
              </span>
              <span className="text-xs font-medium text-primary/80">点击直达</span>
            </div>
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

  useEffect(() => {
    if (status === 'loading') return

    async function fetchStores() {
      try {
        setLoading(true)
        setError(null)

        const data = await fetchManagedProjectsCached<StoreItem[]>(session)
        setStores(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : '未知错误')
      } finally {
        setLoading(false)
      }
    }

    fetchStores()
  }, [session, status])

  const stats = [
    { label: '店铺总数', value: `${stores.length}`, icon: Store },
    { label: '有链接店铺', value: `${stores.filter((s) => s.store_address).length}`, icon: ExternalLink },
    { label: '品牌数量', value: `${new Set(stores.map((s) => s.brand_name).filter(Boolean)).size}`, icon: Building2 },
  ]

  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-7">
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl space-y-3">
            <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90">
              <Store className="h-3.5 w-3.5" />
              运营导航 · 店铺导航
            </p>
            <p className="text-sm leading-6 text-muted-foreground md:text-base">
              聚合团队所有店铺入口，可视化书签卡片，方便一键直达各店铺后台与前台页面。
            </p>
          </div>
          <div className="grid w-full max-w-sm grid-cols-3 gap-2.5">
            {stats.map((item) => (
              <div key={item.label} className="rounded-xl border border-border/70 bg-background/80 p-3 text-center">
                <item.icon className="mx-auto mb-1 h-4 w-4 text-primary/85" />
                <p className="text-base font-semibold leading-tight">{item.value}</p>
                <p className="text-[11px] text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight md:text-xl">全部店铺</h2>
          <p className="text-xs text-muted-foreground md:text-sm">点击卡片直达店铺</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-2xl border border-border/70 bg-card p-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-destructive/50 bg-card p-12 text-center">
            <p className="text-destructive">{error}</p>
          </div>
        ) : (
          <StoreGrid items={stores} />
        )}
      </section>
    </div>
  )
}

'use client'

import { ArrowUpRight, Building2, ExternalLink, Store } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { CardListSkeleton } from '@/components/dashboard/page-skeletons'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

type StoreItem = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
}

const tonePresets = [
  'bg-[#e0e7ff] dark:bg-[#1e1b4b]/60',
  'bg-[#d1fae5] dark:bg-[#064e3b]/60',
  'bg-[#fef3c7] dark:bg-[#78350f]/60',
  'bg-[#fee2e2] dark:bg-[#881337]/60',
  'bg-[#ede9fe] dark:bg-[#4c1d95]/60',
  'bg-[#fce7f3] dark:bg-[#831843]/60',
  'bg-[#cffafe] dark:bg-[#164e63]/60',
  'bg-[#ecfccb] dark:bg-[#365314]/60',
]

function getToneByIndex(index: number): string {
  return tonePresets[index % tonePresets.length]
}

const labelTones = [
  'text-[#3b82f6] bg-[#eff6ff] border-[#dbeafe] dark:text-[#93c5fd] dark:bg-[#1e3a5f] dark:border-[#1e3a5f]',
  'text-[#10b981] bg-[#f0fdf4] border-[#d1fae5] dark:text-[#6ee7b7] dark:bg-[#064e3b] dark:border-[#064e3b]',
  'text-[#f59e0b] bg-[#fffbeb] border-[#fef3c7] dark:text-[#fcd34d] dark:bg-[#78350f] dark:border-[#78350f]',
  'text-[#ef4444] bg-[#fff1f2] border-[#fee2e2] dark:text-[#fca5a5] dark:bg-[#881337] dark:border-[#881337]',
  'text-[#8b5cf6] bg-[#f5f3ff] border-[#ede9fe] dark:text-[#c4b5fd] dark:bg-[#4c1d95] dark:border-[#4c1d95]',
  'text-[#ec4899] bg-[#fdf2f8] border-[#fce7f3] dark:text-[#f9a8d4] dark:bg-[#831843] dark:border-[#831843]',
  'text-[#0891b2] bg-[#ecfeff] border-[#cffafe] dark:text-[#67e8f9] dark:bg-[#164e63] dark:border-[#164e63]',
  'text-[#65a30d] bg-[#f7fee7] border-[#ecfccb] dark:text-[#bef264] dark:bg-[#365314] dark:border-[#365314]',
]

function getLabelToneByIndex(index: number): string {
  return labelTones[index % labelTones.length]
}

type StoreGridProps = {
  items: StoreItem[]
}

function StoreGrid({ items }: StoreGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-border/70 bg-card p-12 text-center dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
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
          className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-card p-4 transition-colors duration-200 hover:border-primary/30 hover:bg-[hsl(var(--surface-soft))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 dark:border-border/70 dark:bg-[hsl(var(--surface-panel))]"
          onClick={(e) => {
            if (!store.store_address) {
              e.preventDefault()
            }
          }}
        >
          <div className={`absolute inset-0 ${getToneByIndex(index)} opacity-50`} />
          <div className="relative z-10 flex h-full flex-col space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium tracking-tight text-foreground/90">
                  {store.name}
                </h2>
                {store.brand_name && (
                  <p
                    className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${getLabelToneByIndex(index)}`}
                  >
                    <Building2 className="h-3 w-3" />
                    {store.brand_name}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-1.5 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]/80">
                <ArrowUpRight className="h-3.5 w-3.5" />
              </div>
            </div>

            <p className="min-h-10 flex-1 text-sm leading-5 text-muted-foreground">
              {store.store_address ? '点击访问店铺页面' : '暂无店铺链接'}
            </p>

            <div className="mt-auto flex items-center justify-between border-t border-border/50 pt-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]/80">
                <ExternalLink className="h-3 w-3" />
                店铺链接
              </span>
              <span className="text-xs text-primary/60 group-hover:text-primary/90">点击直达</span>
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

  const fetchStores = useCallback(async () => {
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
  }, [session])

  useEffect(() => {
    if (status === 'loading') return

    void fetchStores()
  }, [status, fetchStores])

  const stats = [
    { label: '店铺总数', value: `${stores.length}`, icon: Store },
    {
      label: '有链接店铺',
      value: `${stores.filter((s) => s.store_address).length}`,
      icon: ExternalLink,
    },
    {
      label: '品牌数量',
      value: `${new Set(stores.map((s) => s.brand_name).filter(Boolean)).size}`,
      icon: Building2,
    },
  ]

  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface px-5 py-5 md:px-7 md:py-7 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        {/* BLF-505：页面头部收口为 PageHeader 原语（eyebrow pill 形态 + 统计 chips） */}
        <PageHeader
          className="relative z-10"
          eyebrow={
            <>
              <Store className="h-3.5 w-3.5" />
              运营导航 · 店铺导航
            </>
          }
          description="聚合团队所有店铺入口，可视化书签卡片，方便一键直达各店铺后台与前台页面。"
          actions={
            <div className="grid w-full max-w-xs grid-cols-3 gap-2">
              {stats.map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border border-border/50 bg-background/50 p-3 text-center dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]/50"
                >
                  <item.icon className="mx-auto mb-0.5 h-3.5 w-3.5 text-primary/60" />
                  <p className="text-sm font-medium leading-tight text-foreground/80">{item.value}</p>
                  <p className="text-[10px] text-muted-foreground">{item.label}</p>
                </div>
              ))}
            </div>
          }
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-base font-medium tracking-tight text-foreground/80 md:text-lg">
            全部店铺
          </h2>
          <p className="text-xs text-muted-foreground md:text-sm">点击卡片直达店铺</p>
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

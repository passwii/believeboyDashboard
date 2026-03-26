'use client'

import { startTransition, useEffect, useMemo, useState } from 'react'
import { Filter, Loader2 } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

type ProjectOption = {
  id: number
  name: string
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const query = searchParams.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function AdAnalysisTopFilters() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'

  const selectedProjectName = useMemo(
    () => projects.find((item) => String(item.id) === projectId)?.name || '',
    [projectId, projects],
  )

  useEffect(() => {
    let active = true

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)

      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return

        setProjects(payload)

        if (!projectId && payload[0]?.id) {
          const nextSearchParams = new URLSearchParams(searchParams.toString())
          nextSearchParams.set('projectId', String(payload[0].id))
          if (!nextSearchParams.get('country')) {
            nextSearchParams.set('country', country)
          }

          startTransition(() => {
            router.replace(buildHref(pathname, nextSearchParams), { scroll: false })
          })
        }
      } catch (error) {
        if (!active) return
        setProjectsError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        if (active) {
          setProjectsLoading(false)
        }
      }
    }

    void loadProjects()

    return () => {
      active = false
    }
  }, [country, pathname, projectId, router, searchParams, session])

  const updateSearchParam = (key: 'projectId' | 'country', value: string) => {
    const nextSearchParams = new URLSearchParams(searchParams.toString())

    if (value) {
      nextSearchParams.set(key, value)
    } else {
      nextSearchParams.delete(key)
    }

    startTransition(() => {
      router.replace(buildHref(pathname, nextSearchParams), { scroll: false })
    })
  }

  return (
    <Card className="dashboard-surface overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" />
              <p className="dashboard-kicker">Filter Zone</p>
            </div>
            <div>
              <CardTitle className="text-xl">广告分析筛选区</CardTitle>
              <CardDescription className="mt-1">
                筛选条件固定放在顶部，先锁定项目和国家站点，再进入各分析页继续下钻。
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-border/70 bg-background/80 text-foreground">
              项目：{selectedProjectName || '未选择'}
            </Badge>
            <Badge variant="outline" className="border-border/70 bg-background/80 text-foreground">
              国家站点：{COUNTRY_OPTIONS.find((item) => item.value === country)?.label || country}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        <div className="dashboard-toolbar grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(14rem,18rem)_minmax(12rem,14rem)]">
          <div className="space-y-2">
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">项目</div>
            {projectsLoading ? (
              <Skeleton className="h-10 w-full rounded-lg" />
            ) : (
              <Select value={projectId} onValueChange={(value) => updateSearchParam('projectId', value)}>
                <SelectTrigger className="h-10 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="请选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">国家站点</div>
            <Select value={country} onValueChange={(value) => updateSearchParam('country', value)}>
              <SelectTrigger className="h-10 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                <SelectValue placeholder="请选择国家站点" />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_OPTIONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {projectsError ? (
          <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{projectsError}</div>
        ) : null}

        {projectsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在准备项目筛选项...
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

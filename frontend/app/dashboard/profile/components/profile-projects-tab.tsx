'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

interface ProjectItem {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  is_active: boolean
  project_tier: string | null
}

type ProjectRole = '主运营' | '助理运营' | null

const COMMISSION_BASIS_LABEL: Record<string, string> = {
  sales_amount: '销售额',
  cash_received: '平台回款',
  profit_margin: '利润率',
}

const TIER_BADGE_CLASS: Record<string, string> = {
  T1: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800',
  T2: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  T3: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  T4: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300 border-slate-200 dark:border-slate-800',
}

const OPERATOR_SPLIT_RE = /[、,，;\n]+/

function splitNames(value: string | null): string[] {
  if (!value) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value.split(OPERATOR_SPLIT_RE)) {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function deriveRole(
  item: ProjectItem,
  operatorNames: string[],
): ProjectRole {
  if (!operatorNames.length) return null
  if (splitNames(item.project_operator).some((n) => operatorNames.includes(n))) {
    return '主运营'
  }
  if (splitNames(item.assistant_operator).some((n) => operatorNames.includes(n))) {
    return '助理运营'
  }
  return null
}

function formatCommission(
  basis: string | null,
  rate: number | null,
): string {
  if (rate === null) return '—'
  const basisLabel = basis ? COMMISSION_BASIS_LABEL[basis] ?? basis : null
  const pct = (rate * 100).toFixed(2)
  return basisLabel ? `${pct}% · ${basisLabel}` : `${pct}%`
}

export function ProfileProjectsTab() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [items, setItems] = React.useState<ProjectItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // We match projects to the user by name (same convention as
  // backend ``project_service.list_project_items``).
  const operatorNames = React.useMemo(() => {
    const candidates = [
      session?.user?.operatorNameZh,
      session?.user?.name,
    ]
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of candidates) {
      if (!value) continue
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
    return result
  }, [session])

  React.useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    fetchManagedProjectsCached<ProjectItem[]>(session, true)
      .then((data) => {
        if (cancelled) return
        setItems(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = normalizeErrorMessage(err, '项目列表加载失败')
        setError(message)
        notify({ type: 'error', title: message })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  if (error && !items) {
    return (
      <div className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (items === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载项目列表...
      </div>
    )
  }

  // Filter to only the projects where the user actually appears as operator
  // or assistant. Admin users see everything because the backend already
  // returns the full list when ``X-Is-Admin`` is true.
  const isAdmin = session?.user?.roleType === 'admin'
  const visibleItems = isAdmin
    ? items
    : items.filter((item) => deriveRole(item, operatorNames) !== null)

  if (visibleItems.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        暂无可管理的项目。如果你认为自己应该出现在这里，请联系管理员核对运营 / 助理运营名是否一致。
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-medium">项目名</th>
              <th className="px-4 py-3 font-medium">品牌</th>
              <th className="px-4 py-3 font-medium">店铺地址</th>
              <th className="px-4 py-3 font-medium">等级</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">我的角色</th>
              <th className="px-4 py-3 font-medium">佣金比例</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {visibleItems.map((item) => {
              const role = isAdmin ? '管理员' : deriveRole(item, operatorNames)
              const tierClass = item.project_tier ? TIER_BADGE_CLASS[item.project_tier] : ''
              return (
                <tr key={item.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium text-foreground">{item.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.brand_name || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {item.store_address || '—'}
                  </td>
                  <td className="px-4 py-3">
                    {item.project_tier ? (
                      <Badge variant="outline" className={tierClass}>
                        {item.project_tier}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={item.is_active ? 'default' : 'secondary'}
                      className={item.is_active ? '' : 'opacity-70'}
                    >
                      {item.is_active ? '启用' : '停用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {role ? (
                      <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                        {role}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatCommission(item.commission_basis, item.commission_rate)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/system-management/project-info?projectId=${item.id}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      查看
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        共 {visibleItems.length} 个项目。
        {!isAdmin && operatorNames.length === 0 ? (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            ⚠ 当前账号未设置运营名，列表为空。
          </span>
        ) : null}
      </p>
    </div>
  )
}
'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { Crown, ExternalLink, ShieldCheck, UserCog } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

import { ProfileProjectsCard } from './profile-projects-card'
import { ProfileProjectsSkeleton } from './profile-skeletons'
import {
  type ProjectItem,
  TIER_BADGE_CLASS,
  deriveRole,
  formatCommission,
} from './profile-projects-tab-shared'

interface ProfileProjectsTabProps {
  /** Operator-name candidates for matching projects to this user.
   *  Pulled from session in the parent so the operator-names logic stays
   *  here (this tab is the only consumer). */
  operatorNameCandidates: { name: string | null; operatorNameZh: string | null }
}

export function ProfileProjectsTab({ operatorNameCandidates }: ProfileProjectsTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [items, setItems] = React.useState<ProjectItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const operatorNames = React.useMemo(() => {
    const candidates = [operatorNameCandidates.operatorNameZh, operatorNameCandidates.name]
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
  }, [operatorNameCandidates.name, operatorNameCandidates.operatorNameZh])

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
    return <ProfileProjectsSkeleton />
  }

  // Admin users see every project because the backend already returns the full
  // list when ``X-Is-Admin`` is true.
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

  const roleFor = (item: ProjectItem): string | null => {
    return deriveRole(item, operatorNames)
  }

  const RoleBadge = ({ role }: { role: string }) => (
    <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
      {role === '主运营' && <Crown className="mr-1 h-3 w-3" />}
      {role === '助理运营' && <UserCog className="mr-1 h-3 w-3" />}
      {role === '管理员' && <ShieldCheck className="mr-1 h-3 w-3" />}
      {role}
    </Badge>
  )

  return (
    <div className="space-y-2">
      <DataTableCard>
        <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold">项目列表</span>
          <span className="text-xs text-muted-foreground">共 {visibleItems.length} 个项目</span>
        </DataTableCardHeader>
        <DataTableCardBody>
          {/* Desktop */}
          <div className="hidden md:block">
            <div className="overflow-x-auto">
              <Table className="min-w-[860px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                      项目名
                    </TableHead>
                    <TableHead>品牌</TableHead>
                    <TableHead>店铺地址</TableHead>
                    <TableHead>等级</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>我的角色</TableHead>
                    <TableHead>佣金比例</TableHead>
                    <TableHead className="w-[80px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleItems.map((item) => {
                    const role = isAdmin ? '管理员' : roleFor(item)
                    const tierClass = item.project_tier ? TIER_BADGE_CLASS[item.project_tier] : ''
                    return (
                      <TableRow key={item.id} className="transition-colors hover:bg-muted/40">
                        <TableCell className="sticky left-0 z-10 bg-background/95 font-medium text-foreground backdrop-blur supports-[backdrop-filter]:bg-background/60">
                          {item.name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.brand_name || '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.store_address || '—'}
                        </TableCell>
                        <TableCell>
                          {item.project_tier ? (
                            <Badge variant="outline" className={tierClass}>
                              {item.project_tier}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={item.is_active ? 'default' : 'secondary'}
                            className={item.is_active ? '' : 'opacity-70'}
                          >
                            {item.is_active ? '启用' : '停用'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {role ? (
                            <RoleBadge role={role} />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatCommission(item.commission_basis, item.commission_rate)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            href={`/dashboard/system/project-info?projectId=${item.id}`}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            查看
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Mobile */}
          <ProfileProjectsCard items={visibleItems} isAdmin={isAdmin} roleFor={roleFor} />
        </DataTableCardBody>
      </DataTableCard>

      {!isAdmin && operatorNames.length === 0 ? (
        <p className="text-xs text-term-warn">
          ⚠ 当前账号未设置运营名，列表为空。
        </p>
      ) : null}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { ArrowUpRight, Crown, ShieldCheck, UserCog } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { type ProjectItem, TIER_BADGE_CLASS, formatCommission } from './profile-projects-tab-shared'

interface ProfileProjectsCardProps {
  items: ProjectItem[]
  isAdmin: boolean
  roleFor: (item: ProjectItem) => string | null
}

function RoleIcon({ role }: { role: string }) {
  if (role === '主运营') return <Crown className="mr-1 h-3 w-3" />
  if (role === '助理运营') return <UserCog className="mr-1 h-3 w-3" />
  if (role === '管理员') return <ShieldCheck className="mr-1 h-3 w-3" />
  return null
}

export function ProfileProjectsCard({ items, isAdmin, roleFor }: ProfileProjectsCardProps) {
  return (
    <div className="space-y-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
      {items.map((item) => {
        const role = isAdmin ? '管理员' : roleFor(item)
        const href = `/dashboard/system/project-info?projectId=${item.id}`
        return (
          <Link
            key={item.id}
            href={href}
            className={cn(
              'dashboard-surface block min-h-[120px] space-y-3 rounded-xl border border-border/60 p-4 transition-all',
              'hover:border-border hover:shadow-md hover:bg-card/80 active:scale-[0.99]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-foreground">{item.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[item.brand_name, item.store_address].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {item.project_tier ? (
                <Badge variant="outline" className={TIER_BADGE_CLASS[item.project_tier] ?? ''}>
                  {item.project_tier}
                </Badge>
              ) : null}
              <Badge
                variant={item.is_active ? 'default' : 'secondary'}
                className={item.is_active ? '' : 'opacity-70'}
              >
                {item.is_active ? '启用' : '停用'}
              </Badge>
              {role ? (
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                  <RoleIcon role={role} />
                  {role}
                </Badge>
              ) : null}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>佣金比例</span>
              <span className="font-medium text-foreground">
                {formatCommission(item.commission_basis, item.commission_rate)}
              </span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

import { type ProjectItem, formatCommission } from './profile-projects-tab-shared'

interface ProfileProjectsCardProps {
  items: ProjectItem[]
  isAdmin: boolean
  roleFor: (item: ProjectItem) => string | null
}

export function ProfileProjectsCard({ items, isAdmin, roleFor }: ProfileProjectsCardProps) {
  return (
    <div className="space-y-3 md:hidden">
      {items.map((item) => {
        const role = isAdmin ? '管理员' : roleFor(item)
        return (
          <div key={item.id} className="dashboard-surface space-y-3 p-4">
            <div className="flex items-start justify-between gap-2 border-b border-border/70 pb-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{item.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[item.brand_name, item.store_address].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              {item.project_tier ? (
                <Badge variant="outline">{item.project_tier}</Badge>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">状态</div>
                <Badge
                  variant={item.is_active ? 'default' : 'secondary'}
                  className={item.is_active ? '' : 'opacity-70'}
                >
                  {item.is_active ? '启用' : '停用'}
                </Badge>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">我的角色</div>
                {role ? (
                  <Badge
                    variant="outline"
                    className="border-primary/30 bg-primary/10 text-primary"
                  >
                    {role}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">佣金比例</div>
                <div>{formatCommission(item.commission_basis, item.commission_rate)}</div>
              </div>
            </div>

            <div className="border-t border-border/70 pt-2">
              <Link
                href={`/dashboard/system-management/project-info?projectId=${item.id}`}
                className="inline-flex h-9 min-h-[44px] items-center gap-1 text-xs text-primary hover:underline"
              >
                查看项目
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )
      })}
    </div>
  )
}
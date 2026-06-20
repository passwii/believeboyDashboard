'use client'

import { Badge } from '@/components/ui/badge'

import { formatDate, getRoleLabel } from './profile-shared'
import type { Profile } from '@/types/profile'

export function ProfileInfoStats({ profile }: { profile: Profile }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">角色</p>
        <div className="mt-1.5">
          <Badge variant="outline">{getRoleLabel(profile.role_type)}</Badge>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">账号状态</p>
        <div className="mt-1.5">
          <Badge variant={profile.is_active ? 'default' : 'destructive'}>
            {profile.is_active ? '启用' : '停用'}
          </Badge>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">上次修改密码</p>
        <p className="mt-1.5 text-sm">{formatDate(profile.password_changed_at)}</p>
      </div>
    </div>
  )
}
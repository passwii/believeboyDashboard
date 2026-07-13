'use client'

import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { formatDate, getRoleLabel } from './profile-shared'
import type { Profile, ProfileRoleType } from '@/types/profile'

const ROLE_DESCRIPTIONS: Record<ProfileRoleType, string> = {
  admin: '系统全局权限',
  operator: '业务运营权限',
  businessdev: '招商业务权限',
}

interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  description: string
}

function StatCard({ icon, label, value, description }: StatCardProps) {
  return (
    <div
      className={cn(
        'group relative rounded-xl border border-border/60 bg-card/50 p-4 transition-all duration-200',
        'hover:border-border hover:shadow-md hover:bg-card/80'
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </div>
  )
}

export function ProfileInfoStats({ profile }: { profile: Profile }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
      <StatCard
        icon={<ShieldCheck className="h-4 w-4 text-primary" />}
        label="角色"
        value={getRoleLabel(profile.role_type)}
        description={ROLE_DESCRIPTIONS[profile.role_type]}
      />

      <StatCard
        icon={
          profile.is_active ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldOff className="h-4 w-4 text-destructive" />
          )
        }
        label="账号状态"
        value={
          <Badge variant={profile.is_active ? 'default' : 'destructive'}>
            {profile.is_active ? '启用' : '停用'}
          </Badge>
        }
        description={profile.is_active ? '可正常登录并使用系统功能' : '已被停用，无法登录'}
      />

      <StatCard
        icon={<KeyRound className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
        label="上次修改密码"
        value={
          profile.password_changed_at ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">{formatDate(profile.password_changed_at)}</span>
              </TooltipTrigger>
              <TooltipContent>
                <p>完整时间：{profile.password_changed_at}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        }
        description={profile.password_changed_at ? '点击查看完整时间戳' : '尚未修改过密码'}
      />
    </div>
  )
}

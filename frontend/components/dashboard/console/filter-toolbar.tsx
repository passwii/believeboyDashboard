'use client'

import { Filter } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface FilterToolbarProps {
  title?: string
  description?: string
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
  surfaceClassName?: string
  contentClassName?: string
  showHeader?: boolean
  kickerLabel?: string
  badge?: React.ReactNode
}

export function FilterToolbar({
  title = '控制台',
  description,
  children,
  actions,
  className,
  surfaceClassName,
  contentClassName,
  showHeader = true,
  kickerLabel = '控制台',
  badge,
}: FilterToolbarProps) {
  if (showHeader === false) {
    return (
      <div
        className={cn(
          'dashboard-toolbar grid gap-3 md:grid-cols-2 xl:flex xl:flex-wrap xl:items-end xl:gap-3',
          className,
        )}
      >
        {children}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
    )
  }

  return (
    <Card className={cn('dashboard-surface overflow-hidden', surfaceClassName)}>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-primary" />
            <p className="dashboard-kicker">{kickerLabel}</p>
            {title && <CardTitle className="text-xl">{title}</CardTitle>}
          </div>
          {description && <CardDescription>{description}</CardDescription>}
          {badge}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      </CardHeader>

      <CardContent className={cn('dashboard-toolbar grid gap-3 pt-0 md:grid-cols-2 xl:grid-cols-4', contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )
}
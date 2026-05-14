'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

type StatusContext = {
  description?: string
  riskNotes?: string
}

type StatusCardProps = {
  value: StatusContext | null | undefined
  onChange: (value: StatusContext) => void
}

export function StatusCard({ value, onChange }: StatusCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  const preview = value?.description?.slice(0, 80) || '未填写'

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 px-4 cursor-pointer hover:bg-muted/30 rounded-t-lg transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            📊
          </Badge>
          <span className="font-medium">项目状态</span>
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {preview}
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">
              说明
            </label>
            <textarea
              value={value?.description || ''}
              onChange={(e) => onChange({ ...value, description: e.target.value })}
              placeholder="例如：2024 年 10 月新开项目，目前处于爬坡期"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">
              风险备注
            </label>
            <textarea
              value={value?.riskNotes || ''}
              onChange={(e) => onChange({ ...value, riskNotes: e.target.value })}
              placeholder="例如：广告 ACOS 偏高，正在优化中"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
        </CardContent>
      )}
    </Card>
  )
}
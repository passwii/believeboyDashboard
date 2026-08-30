'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

type SeasonalityContext = {
  peakSeason?: string
  offSeason?: string
  restockStrategy?: string
}

type SeasonalityCardProps = {
  value: SeasonalityContext | null | undefined
  onChange: (value: SeasonalityContext) => void
}

export function SeasonalityCard({ value, onChange }: SeasonalityCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  const preview = value?.peakSeason?.slice(0, 60) || value?.offSeason?.slice(0, 60) || '未填写'

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 px-4 cursor-pointer hover:bg-term-hover rounded-none transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            📅
          </Badge>
          <span className="font-medium">淡旺季</span>
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <span className="text-xs text-term-muted truncate max-w-[200px]">{preview}</span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-term-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
          <div>
            <label className="text-sm font-medium text-term-muted mb-1 block">高峰期</label>
            <textarea
              value={value?.peakSeason || ''}
              onChange={(e) => onChange({ ...value, peakSeason: e.target.value })}
              placeholder="例如：Q4（10-12 月）销量占全年 45%"
              rows={2}
              className="w-full rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm ring-offset-term-bg placeholder:text-term-muted focus-visible:outline-none focus-visible:outline-none focus-visible:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-term-muted mb-1 block">淡季</label>
            <textarea
              value={value?.offSeason || ''}
              onChange={(e) => onChange({ ...value, offSeason: e.target.value })}
              placeholder="例如：Q2（4-6 月）为淡季，建议控制库存水位"
              rows={2}
              className="w-full rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm ring-offset-term-bg placeholder:text-term-muted focus-visible:outline-none focus-visible:outline-none focus-visible:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-term-muted mb-1 block">备货策略</label>
            <textarea
              value={value?.restockStrategy || ''}
              onChange={(e) => onChange({ ...value, restockStrategy: e.target.value })}
              placeholder="例如：旺季前 45 天开始备货"
              rows={2}
              className="w-full rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm ring-offset-term-bg placeholder:text-term-muted focus-visible:outline-none focus-visible:outline-none focus-visible:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
        </CardContent>
      )}
    </Card>
  )
}

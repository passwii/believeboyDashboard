'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

type NotesCardProps = {
  value: string | null | undefined
  onChange: (value: string) => void
}

export function NotesCard({ value, onChange }: NotesCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  const preview = value?.slice(0, 80) || '未填写'

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 px-4 cursor-pointer hover:bg-muted/30 rounded-t-lg transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            📝
          </Badge>
          <span className="font-medium">自由备注</span>
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
        <CardContent className="px-4 pb-4" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="在此填写任何补充信息，如特殊说明、注意事项或其他需要记录的内容..."
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
        </CardContent>
      )}
    </Card>
  )
}
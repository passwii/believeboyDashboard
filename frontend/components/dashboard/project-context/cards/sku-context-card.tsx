'use client'

import { useState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type SkuContext = Record<string, SkuStatusItem>

type SkuStatusItem = {
  status?: string
  reason?: string
  action?: string
  startDate?: string
  endDate?: string
}

type SkuContextCardProps = {
  value: SkuContext | null | undefined
  onChange: (value: SkuContext) => void
}

export function SkuContextCard({ value, onChange }: SkuContextCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [newSku, setNewSku] = useState('')

  const skuList = Object.entries(value || {})
  const preview = skuList.length > 0 ? `${skuList.length} 个 SKU 已配置` : '未填写'

  const handleAdd = () => {
    if (!newSku.trim()) return
    const trimmed = newSku.trim().toUpperCase()
    if (value?.[trimmed]) {
      setNewSku('')
      return
    }
    const updated = { ...value, [trimmed]: { status: '', reason: '', action: '' } }
    onChange(updated)
    setNewSku('')
  }

  const handleDelete = (sku: string) => {
    const updated = { ...value } as SkuContext
    delete updated[sku]
    onChange(updated)
  }

  const handleUpdateSku = (sku: string, field: keyof SkuStatusItem, fieldValue: string) => {
    const updated = {
      ...value,
      [sku]: { ...value?.[sku], [field]: fieldValue },
    } as SkuContext
    onChange(updated)
  }

  const handleSkuRename = (oldSku: string, newSkuKey: string) => {
    if (!newSkuKey.trim() || oldSku === newSkuKey) return
    const trimmed = newSkuKey.trim().toUpperCase()
    if (value?.[trimmed]) return
    const updated = { ...value } as SkuContext
    const item = updated[oldSku]
    delete updated[oldSku]
    updated[trimmed] = item
    onChange(updated)
  }

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 px-4 cursor-pointer hover:bg-term-hover rounded-none transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            🔥
          </Badge>
          <span className="font-medium">SKU 特殊状态</span>
          {skuList.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {skuList.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && <span className="text-xs text-term-muted">{preview}</span>}
          <ChevronDown
            className={`h-4 w-4 text-term-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-4 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
          {skuList.map(([sku, item]) => (
            <div key={sku} className="border rounded-none p-3 space-y-2 relative bg-term-hover">
              <div className="flex items-center justify-between gap-2">
                <Input
                  value={sku}
                  onChange={(e) => handleSkuRename(sku, e.target.value)}
                  placeholder="SKU 编码"
                  className="font-mono text-sm h-8 w-40"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(sku)}
                  className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-term-muted mb-1 block">状态</label>
                  <Input
                    value={item.status || ''}
                    onChange={(e) => handleUpdateSku(sku, 'status', e.target.value)}
                    placeholder="清仓/秒杀/停产"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-term-muted mb-1 block">开始日期</label>
                  <Input
                    type="date"
                    value={item.startDate || ''}
                    onChange={(e) => handleUpdateSku(sku, 'startDate', e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-term-muted mb-1 block">原因</label>
                <Input
                  value={item.reason || ''}
                  onChange={(e) => handleUpdateSku(sku, 'reason', e.target.value)}
                  placeholder="简述原因"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-term-muted mb-1 block">行动</label>
                <Input
                  value={item.action || ''}
                  onChange={(e) => handleUpdateSku(sku, 'action', e.target.value)}
                  placeholder="正在采取的措施"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-term-muted mb-1 block">结束日期</label>
                <Input
                  type="date"
                  value={item.endDate || ''}
                  onChange={(e) => handleUpdateSku(sku, 'endDate', e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <Input
              value={newSku}
              onChange={(e) => setNewSku(e.target.value.toUpperCase())}
              placeholder="输入 SKU 编码以新增"
              className="font-mono text-sm h-9 flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleAdd}
              disabled={!newSku.trim()}
              className="h-9"
            >
              <Plus className="h-4 w-4 mr-1" />
              新增
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

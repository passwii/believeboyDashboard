'use client'

import { useState } from 'react'
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type DimensionItem = {
  key: string
  value: string
}

type DynamicContextCardProps = {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  onAiImport?: () => void
}

export function DynamicContextCard({ value, onChange, onAiImport }: DynamicContextCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [newKeyMode, setNewKeyMode] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const dimensions: DimensionItem[] = Object.entries(value).map(([key, val]) => ({ key, value: val }))

  let preview = dimensions.length > 0
    ? dimensions.slice(0, 3).map(d => d.key).join('、')
    : '未填写'
  if (dimensions.length > 3) {
    preview += ` 等 ${dimensions.length} 个`
  }

  const handleKeyChange = (oldKey: string, newKey: string) => {
    if (!newKey.trim()) return
    const newValue: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === oldKey) {
        newValue[newKey] = v
      } else {
        newValue[k] = v
      }
    }
    onChange(newValue)
  }

  const handleValueChange = (key: string, newVal: string) => {
    onChange({ ...value, [key]: newVal })
  }

  const handleDelete = (key: string) => {
    const newValue: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k !== key) {
        newValue[k] = v
      }
    }
    onChange(newValue)
  }

  const handleAdd = () => {
    if (!newKey.trim()) return
    onChange({ ...value, [newKey]: newValue })
    setNewKey('')
    setNewValue('')
    setNewKeyMode(false)
  }

  const handleCancelAdd = () => {
    setNewKey('')
    setNewValue('')
    setNewKeyMode(false)
  }

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 px-4 cursor-pointer hover:bg-muted/30 rounded-t-lg transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            📋
          </Badge>
          <span className="font-medium">项目背景</span>
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
          {/* 操作栏 */}
          <div className="flex items-center justify-between border-b pb-2">
            <span className="text-xs text-muted-foreground">
              {dimensions.length} 个维度
            </span>
            <div className="flex items-center gap-2">
              {onAiImport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onAiImport}
                  className="h-7 text-xs"
                >
                  🤖 AI 辅助
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewKeyMode(true)}
                className="h-7 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                添加维度
              </Button>
            </div>
          </div>

          {/* 维度列表 */}
          <div className="space-y-3">
            {dimensions.map(({ key, value: dimValue }, index) => (
              <div
                key={`${key}-${index}`}
                className="rounded-md border border-border/40 bg-background p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  {editingKey === key ? (
                    <Input
                      value={key}
                      onChange={(e) => handleKeyChange(key, e.target.value)}
                      onBlur={() => setEditingKey(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setEditingKey(null)
                      }}
                      className="h-7 font-medium"
                      autoFocus
                    />
                  ) : (
                    <span
                      className="font-medium text-sm cursor-pointer hover:text-primary flex-1"
                      onClick={() => setEditingKey(key)}
                    >
                      {key}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(key)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                <textarea
                  value={dimValue}
                  onChange={(e) => handleValueChange(key, e.target.value)}
                  placeholder="输入维度描述..."
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                />
              </div>
            ))}

            {/* 新增模式 */}
            {newKeyMode && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="维度名称（如：供应商信息）"
                  className="h-8 font-medium"
                  autoFocus
                />
                <Textarea
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="输入维度描述..."
                  rows={2}
                  className="text-sm resize-none"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={handleCancelAdd} className="h-7 text-xs">
                    取消
                  </Button>
                  <Button size="sm" onClick={handleAdd} disabled={!newKey.trim()} className="h-7 text-xs">
                    添加
                  </Button>
                </div>
              </div>
            )}

            {/* 空状态 */}
            {dimensions.length === 0 && !newKeyMode && (
              <div className="text-center py-6 text-muted-foreground text-sm">
                <p>暂无维度信息</p>
                <p className="text-xs mt-1">点击「添加维度」或「AI 辅助」开始</p>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

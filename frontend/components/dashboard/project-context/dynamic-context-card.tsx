'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Pencil, Plus, Trash2, Check } from 'lucide-react'

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
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  readOnly?: boolean
}

export function DynamicContextCard({
  value,
  onChange,
  onAiImport,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  readOnly = false,
}: DynamicContextCardProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const collapsed = controlledCollapsed ?? internalCollapsed
  const setCollapsed = onCollapsedChange ?? setInternalCollapsed

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingKeyValue, setEditingKeyValue] = useState('')
  const [newKeyMode, setNewKeyMode] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const keyInputRef = useRef<HTMLInputElement>(null)

  const dimensions: DimensionItem[] = Object.entries(value).map(([key, val]) => ({
    key,
    value: val,
  }))

  useEffect(() => {
    if (editingKey && keyInputRef.current) {
      keyInputRef.current.focus()
    }
  }, [editingKey])

  const handleStartEditKey = (key: string) => {
    setEditingKey(key)
    setEditingKeyValue(key)
  }

  const handleConfirmEditKey = () => {
    if (editingKey && editingKeyValue.trim() && editingKeyValue !== editingKey) {
      const newValue: Record<string, string> = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === editingKey) {
          newValue[editingKeyValue] = v
        } else {
          newValue[k] = v
        }
      }
      onChange(newValue)
    }
    setEditingKey(null)
    setEditingKeyValue('')
  }

  const handleCancelEditKey = () => {
    setEditingKey(null)
    setEditingKeyValue('')
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
    <div className="dashboard-surface overflow-hidden">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-border/70 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">维度信息</span>
          <span className="text-xs text-muted-foreground">({dimensions.length} 个)</span>
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && dimensions.length > 0 && (
            <span className="text-xs text-muted-foreground truncate max-w-[180px]">
              {dimensions
                .slice(0, 3)
                .map((d) => d.key)
                .join('、')}
              {dimensions.length > 3 && ` 等 ${dimensions.length} 个`}
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </div>
      </div>

      {/* 内容区 */}
      {!collapsed && (
        <div onClick={(e) => e.stopPropagation()}>
          {/* 操作栏 */}
          {!readOnly && (
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-muted/20">
              <span className="text-xs text-muted-foreground">{dimensions.length} 个维度</span>
              <div className="flex items-center gap-2">
                {onAiImport && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onAiImport}
                    className="h-7 text-xs gap-1"
                  >
                    <span>🤖</span>
                    AI 辅助
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setNewKeyMode(true)}
                  className="h-7 text-xs"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  添加维度
                </Button>
              </div>
            </div>
          )}

          {/* 维度列表 */}
          <div className="divide-y divide-border/50">
            {dimensions.map(({ key, value: dimValue }) => (
              <div
                key={key}
                className="flex items-start px-4 py-3 hover:bg-muted/20 transition-colors"
              >
                {/* Key */}
                <div className="w-28 shrink-0 pr-4">
                  {editingKey === key && !readOnly ? (
                    <div className="flex items-center gap-1">
                      <Input
                        ref={keyInputRef}
                        value={editingKeyValue}
                        onChange={(e) => setEditingKeyValue(e.target.value)}
                        onBlur={handleConfirmEditKey}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConfirmEditKey()
                          if (e.key === 'Escape') handleCancelEditKey()
                        }}
                        className="h-7 text-sm font-medium"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleConfirmEditKey}
                        className="h-7 w-7 p-0 shrink-0"
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-muted-foreground truncate">{key}</span>
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleStartEditKey(key)}
                          className="h-6 w-6 p-0 opacity-0 hover:opacity-100 shrink-0"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* Value */}
                <div className="flex-1 min-w-0">
                  {!readOnly ? (
                    <Textarea
                      value={dimValue}
                      onChange={(e) => handleValueChange(key, e.target.value)}
                      placeholder="输入维度描述..."
                      rows={2}
                      className="text-sm resize-none min-h-[60px]"
                    />
                  ) : (
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                      {dimValue || <span className="text-muted-foreground italic">未填写</span>}
                    </p>
                  )}
                </div>

                {/* 操作按钮 */}
                {!readOnly && editingKey !== key && (
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(key)}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}

            {/* 新增维度行 */}
            {newKeyMode && (
              <div className="flex items-start px-4 py-3 bg-primary/5">
                <div className="w-28 shrink-0 pr-4">
                  <Input
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="维度名称"
                    className="h-7 text-sm font-medium"
                    autoFocus
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <Textarea
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder="输入维度描述..."
                    rows={2}
                    className="text-sm resize-none min-h-[60px]"
                  />
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancelAdd}
                    className="h-7 text-xs"
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleAdd}
                    disabled={!newKey.trim()}
                    className="h-7 text-xs"
                  >
                    添加
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 空状态 */}
          {dimensions.length === 0 && !newKeyMode && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <p>暂无维度信息</p>
              {!readOnly && <p className="text-xs mt-1">点击「添加维度」或「AI 辅助」开始</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

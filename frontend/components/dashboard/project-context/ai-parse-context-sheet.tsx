'use client'

import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useNotifications } from '@/components/notifications'
import { Plus, Trash2 } from 'lucide-react'

const API_BASE = '/api/backend'

type ParsedKeyValue = Record<string, string>

interface AiParseContextSheetProps {
  open: boolean
  projectId: number
  projectName: string
  onClose: () => void
  onParsed: (context: ParsedKeyValue) => void
}

export function AiParseContextSheet({
  open,
  projectId,
  projectName,
  onClose,
  onParsed,
}: AiParseContextSheetProps) {
  const { notify } = useNotifications()
  const [description, setDescription] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsedItems, setParsedItems] = useState<ParsedKeyValue | null>(null)
  const [editingItems, setEditingItems] = useState<ParsedKeyValue>({})
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    if (open) {
      setDescription('')
      setParsedItems(null)
      setEditingItems({})
      setParsing(false)
      setIsEditing(false)
    }
  }, [open])

  const handleParse = async () => {
    if (!description.trim()) {
      notify({ type: 'warning', title: '请输入项目背景描述' })
      return
    }

    setParsing(true)
    setParsedItems(null)
    setEditingItems({})
    setIsEditing(false)

    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || 'AI 解析失败')
      }

      const data = await response.json()
      setParsedItems(data.result)
      setEditingItems(data.result || {})
      setIsEditing(true)

      if (!data.result || Object.keys(data.result).length === 0) {
        notify({ type: 'warning', title: '解析结果为空', message: '请检查输入描述是否正确' })
      } else {
        const count = Object.keys(data.result).length
        notify({ type: 'success', title: '解析成功', message: `已识别 ${count} 个维度` })
      }
    } catch (err) {
      notify({
        type: 'error',
        title: 'AI 解析失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setParsing(false)
    }
  }

  const handleSave = () => {
    if (Object.keys(editingItems).length === 0) {
      notify({ type: 'warning', title: '请至少保留一个维度' })
      return
    }
    onParsed(editingItems)
    onClose()
  }

  const handleKeyChange = (oldKey: string, newKey: string) => {
    const value = editingItems[oldKey]
    const newItems = { ...editingItems }
    delete newItems[oldKey]
    newItems[newKey] = value
    setEditingItems(newItems)
  }

  const handleValueChange = (key: string, value: string) => {
    setEditingItems({ ...editingItems, [key]: value })
  }

  const handleDelete = (key: string) => {
    const newItems = { ...editingItems }
    delete newItems[key]
    setEditingItems(newItems)
  }

  const handleAdd = () => {
    const count = Object.keys(editingItems).length + 1
    setEditingItems({ ...editingItems, [`新维度${count}`]: '' })
  }

  const hasAnyContent = editingItems && Object.keys(editingItems).length > 0

  return (
    <Sheet
      open={open}
      onOpenChange={(openState) => {
        if (!openState) onClose()
      }}
    >
      <SheetContent className="w-full max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="text-2xl">🤖</span>
            AI 辅助填充项目背景
          </SheetTitle>
          <div className="text-sm text-muted-foreground">项目：{projectName}</div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* 输入区域 */}
          <div className="space-y-3">
            <label className="text-sm font-medium">项目背景描述</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`请输入项目的背景信息，AI 将自动解析为结构化的维度信息。

例如：
"深圳华强北供应商，月产能 5000 件，旺季可扩到 8000。交货周期 15 天，淡季 10 天。对接人王经理响应快。

旺季是 11-12 月礼品季，3-4 月开学季，需要提前 2 个月备货。淡季 6-8 月可以考虑清库存。

去年增长率 30%，主要是新品上线带动。新品开发周期 3 周。

目前库存周转率偏低，风险是交期延误。"

支持任意格式的输入，AI 会自动分类整理成 Key-Value 形式。`}
              className="min-h-[180px] text-sm"
              disabled={parsing}
            />
            <div className="flex justify-between items-center">
              <p className="text-xs text-muted-foreground">AI 会自动识别并生成维度名称和对应描述</p>
              <Button onClick={handleParse} disabled={parsing || !description.trim()} size="sm">
                {parsing ? (
                  <>
                    <span className="mr-2 animate-spin">⏳</span>
                    AI 解析中...
                  </>
                ) : (
                  '🤖 AI 解析'
                )}
              </Button>
            </div>
          </div>

          {/* 预览/编辑区域 */}
          {isEditing && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2">
                <label className="text-sm font-medium">解析结果（可编辑）</label>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {Object.keys(editingItems).length} 个维度
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={handleAdd} className="h-7 text-xs">
                    <Plus className="h-3 w-3 mr-1" />
                    添加维度
                  </Button>
                </div>
              </div>

              {/* 维度列表 */}
              <div className="space-y-3">
                {Object.entries(editingItems).map(([key, value], index) => (
                  <div
                    key={`${key}-${index}`}
                    className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">📋</span>
                      <Input
                        value={key}
                        onChange={(e) => handleKeyChange(key, e.target.value)}
                        className="font-medium h-8"
                        placeholder="维度名称"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(key)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <Textarea
                      value={value}
                      onChange={(e) => handleValueChange(key, e.target.value)}
                      className="min-h-[60px] text-sm resize-none"
                      placeholder="输入维度描述..."
                    />
                  </div>
                ))}

                {Object.keys(editingItems).length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    暂无维度，请添加或重新解析
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          {isEditing && (
            <div className="flex items-center justify-between border-t border-border/60 pt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDescription('')
                  setParsedItems(null)
                  setEditingItems({})
                  setIsEditing(false)
                }}
              >
                重新输入
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  取消
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!hasAnyContent}>
                  填充到表单
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

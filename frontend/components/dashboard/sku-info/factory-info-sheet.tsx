'use client'

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'


type FactoryPair = { key: string; value: string }

const API_BASE = '/api/backend'

function pairsToJson(pairs: FactoryPair[]): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const pair of pairs) {
    const k = pair.key.trim()
    if (k) obj[k] = pair.value
  }
  return obj
}

function jsonToPairs(json: Record<string, unknown> | null | undefined): FactoryPair[] {
  if (!json) return []
  return Object.entries(json).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}

export default function FactoryInfoSheet({
  open,
  productCostId,
  skuLabel,
  factoryInfo,
  onClose,
  onSaved,
}: {
  open: boolean
  productCostId: number
  skuLabel: string
  factoryInfo: Record<string, unknown> | null
  onClose: () => void
  onSaved: (saved: boolean) => void
}) {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [pairs, setPairs] = useState<FactoryPair[]>([])
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      const initial = jsonToPairs(factoryInfo)
      setPairs(initial)
      setJsonMode(false)
      setJsonText(JSON.stringify(pairsToJson(initial), null, 2))
    }
  }, [open, factoryInfo])

  const syncJsonFromPairs = useCallback((currentPairs: FactoryPair[]) => {
    setJsonText(JSON.stringify(pairsToJson(currentPairs), null, 2))
  }, [])

  const syncPairsFromJson = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        notify({ type: 'error', title: 'JSON 格式错误', message: 'JSON 必须是一个对象' })
        return
      }
      const newPairs: FactoryPair[] = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      }))
      setPairs(newPairs)
    } catch {
      notify({ type: 'error', title: 'JSON 解析失败', message: '请检查 JSON 格式' })
    }
  }, [notify])

  const updatePair = (index: number, field: 'key' | 'value', value: string) => {
    const next = [...pairs]
    next[index] = { ...next[index], [field]: value }
    setPairs(next)
    if (!jsonMode) syncJsonFromPairs(next)
  }

  const addPair = () => {
    const next = [...pairs, { key: '', value: '' }]
    setPairs(next)
    if (!jsonMode) syncJsonFromPairs(next)
  }

  const removePair = (index: number) => {
    const next = pairs.filter((_, i) => i !== index)
    setPairs(next)
    if (!jsonMode) syncJsonFromPairs(next)
  }

  const toggleMode = () => {
    if (jsonMode) {
      syncPairsFromJson(jsonText)
    } else {
      setJsonText(JSON.stringify(pairsToJson(pairs), null, 2))
    }
    setJsonMode(!jsonMode)
  }

  const handleSave = async () => {
    const finalJson = jsonMode
      ? (() => {
          try {
            const parsed = JSON.parse(jsonText)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              notify({ type: 'error', title: 'JSON 格式错误' })
              return null
            }
            return parsed as Record<string, string>
          } catch {
            notify({ type: 'error', title: 'JSON 解析失败' })
            return null
          }
        })()
      : pairsToJson(pairs)

    if (finalJson === null) return

    const isEmpty = Object.keys(finalJson).length === 0
    setSaving(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/${productCostId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku_factory_info: isEmpty ? null : finalJson,
          sku: skuLabel, // 保留原 SKU，不允许在此修改
        }),
      })
      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || '保存失败')
      }
      notify({ type: 'success', title: '产品属性已保存' })
      onSaved(true)
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: err instanceof Error ? err.message : '未知错误' })
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    if (!await confirm({ title: '确定要清除该 SKU 的产品属性吗？', variant: 'destructive' })) return
    setSaving(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/${productCostId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku_factory_info: null }),
      })
      if (!response.ok) throw new Error('清除失败')
      notify({ type: 'success', title: '产品属性已清除' })
      onSaved(true)
    } catch {
      notify({ type: 'error', title: '清除失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(openState) => { if (!openState) onClose() }}>
      <SheetContent className='w-full max-w-2xl overflow-y-auto'>
        <SheetHeader>
          <SheetTitle>编辑产品属性 - {skuLabel}</SheetTitle>
        </SheetHeader>

        <div className='mt-6 space-y-4'>
          <div className='flex justify-end'>
            <Button type='button' variant='outline' size='sm' onClick={toggleMode}>
              {jsonMode ? '切换到表单编辑' : '切换到 JSON 编辑'}
            </Button>
          </div>

          {jsonMode ? (
            <textarea
              className='min-h-[300px] w-full rounded-lg border border-border/60 bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={'请输入 JSON，例如：\n{\n  "参数信息": "...",\n  "电压": "220V"\n}'}
            />
          ) : (
            <div className='space-y-3'>
              {pairs.length === 0 && (
                <p className='text-sm text-muted-foreground'>暂无产品属性，请添加字段。</p>
              )}
              {pairs.map((pair, index) => (
                <div key={index} className='flex items-start gap-2'>
                  <div className='flex-1 space-y-1'>
                    <label className='text-xs text-muted-foreground'>字段名（中文）</label>
                    <Input
                      value={pair.key}
                      onChange={(e) => updatePair(index, 'key', e.target.value)}
                      placeholder='参数信息'
                    />
                  </div>
                  <div className='flex-1 space-y-1'>
                    <label className='text-xs text-muted-foreground'>字段值</label>
                    <Input
                      value={pair.value}
                      onChange={(e) => updatePair(index, 'value', e.target.value)}
                      placeholder='字段值'
                    />
                  </div>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='mt-5 text-destructive hover:text-destructive'
                    onClick={() => removePair(index)}
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button type='button' variant='outline' size='sm' onClick={addPair}>
                + 添加字段
              </Button>
            </div>
          )}

          <div className='flex items-center justify-between border-t border-border/60 pt-4'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='text-destructive hover:text-destructive'
              onClick={handleClear}
              disabled={saving}
            >
              清除产品属性
            </Button>
            <div className='flex gap-2'>
              <Button type='button' variant='outline' size='sm' onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button type='button' size='sm' onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

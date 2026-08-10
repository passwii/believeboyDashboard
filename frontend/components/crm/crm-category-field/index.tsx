'use client'

/**
 * CrmCategoryField — 客户抽屉「产品类目」字段（P6b）。
 *
 * 当前类目 chips；编辑弹 popover 多选（checkbox 列表，数据来自 GET /crm/categories）；
 * 保存调 PUT /customers/{id}/categories 整体替换。仅 owner/admin 可编辑（后端校验）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { Category, CategoryBrief, Customer } from '@/lib/crm/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useNotifications } from '@/components/notifications'

function toBrief(c: Category): CategoryBrief {
  return { id: c.id, name: c.name }
}

export function CrmCategoryField({
  customer,
  onSaved,
}: {
  customer: Customer
  onSaved?: (updated: Customer) => void
}) {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const [categories, setCategories] = useState<Category[]>([])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setCategories(await client.listCategories())
    } catch {
      setLoadError('类目加载失败')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setSelected(new Set((customer.categories ?? []).map((c) => c.id)))
  }, [customer.categories])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await client.setCustomerCategories(
        customer.id,
        Array.from(selected)
      )
      onSaved?.(updated)
      notify({ type: 'success', title: '产品类目已更新' })
      setOpen(false)
    } catch {
      notify({ type: 'error', title: '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {(customer.categories ?? []).length > 0 ? (
          (customer.categories ?? []).map((c) => (
            <Badge key={c.id} variant="secondary" className="font-normal">
              {c.name}
            </Badge>
          ))
        ) : (
          <span className="text-sm text-muted-foreground">未设置</span>
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs">
              <Plus className="h-3 w-3" />
              编辑
              <ChevronsUpDown className="h-3 w-3 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-0">
            <div className="max-h-60 overflow-y-auto p-1.5">
              {loading ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : loadError ? (
                <div className="space-y-2 px-2 py-3 text-sm text-rose-600 dark:text-rose-400">
                  <p>{loadError}</p>
                  <Button variant="outline" size="sm" onClick={() => void load()}>
                    重试
                  </Button>
                </div>
              ) : (
                categories.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={() => toggle(c.id)}
                    />
                    <span className="flex-1">{c.name}</span>
                    {selected.has(c.id) && (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border/60 p-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelected(new Set((customer.categories ?? []).map((c) => c.id)))
                  setOpen(false)
                }}
              >
                取消
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

CrmCategoryField.displayName = 'CrmCategoryField'

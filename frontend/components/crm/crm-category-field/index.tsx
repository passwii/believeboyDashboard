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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useNotifications } from '@/components/notifications'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './crm-category-field-warm.module.css'

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
    <div className={styles.field}>
      <div className={styles.chips}>
        {(customer.categories ?? []).length > 0 ? (
          (customer.categories ?? []).map((c) => (
            <WarmCrmStatusPill key={c.id}>
              {c.name}
            </WarmCrmStatusPill>
          ))
        ) : (
          <span className={styles.muted}>未设置</span>
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <WarmButton className={styles.editButton}>
              <Plus className="h-3 w-3" />
              编辑
              <ChevronsUpDown className="h-3 w-3 opacity-60" />
            </WarmButton>
          </PopoverTrigger>
          <PopoverContent align="start" className={styles.popover}>
            <div className={styles.options}>
              {loading ? (
                <div className={styles.loading}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : loadError ? (
                <div className={styles.error}>
                  <p>{loadError}</p>
                  <WarmButton onClick={() => void load()}>
                    重试
                  </WarmButton>
                </div>
              ) : (
                categories.map((c) => (
                  <label key={c.id} className={styles.option}>
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={() => toggle(c.id)}
                    />
                    <span className="flex-1">{c.name}</span>
                    {selected.has(c.id) && (
                      <Check className={styles.check} />
                    )}
                  </label>
                ))
              )}
            </div>
            <div className={styles.actions}>
              <WarmButton
                variant="quiet"
                onClick={() => {
                  setSelected(new Set((customer.categories ?? []).map((c) => c.id)))
                  setOpen(false)
                }}
              >
                取消
              </WarmButton>
              <WarmButton variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </WarmButton>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

CrmCategoryField.displayName = 'CrmCategoryField'

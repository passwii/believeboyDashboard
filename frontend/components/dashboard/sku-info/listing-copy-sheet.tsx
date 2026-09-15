'use client'

import { useEffect, useState, type ChangeEvent } from 'react'

import { useNotifications } from '@/components/notifications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

const API_BASE = '/api/backend'

const COPY_FIELDS = [
  'listing_title',
  'listing_bullet_1',
  'listing_bullet_2',
  'listing_bullet_3',
  'listing_bullet_4',
  'listing_bullet_5',
  'listing_description',
  'listing_selling_points',
] as const

type CopyField = (typeof COPY_FIELDS)[number]
type CopyValues = Record<CopyField, string>
type ListingCopyRow = {
  id: number
  sku: string
  listing_title: string | null
  listing_bullet_1: string | null
  listing_bullet_2: string | null
  listing_bullet_3: string | null
  listing_bullet_4: string | null
  listing_bullet_5: string | null
  listing_description: string | null
  listing_selling_points: string | null
}

function valuesFromRow(row: ListingCopyRow): CopyValues {
  return Object.fromEntries(COPY_FIELDS.map((field) => [field, row[field] ?? ''])) as CopyValues
}

export function buildListingCopyPayload(row: ListingCopyRow, values: CopyValues) {
  const initialValues = valuesFromRow(row)
  const changedFields = Object.fromEntries(
    COPY_FIELDS.filter((field) => values[field] !== initialValues[field]).map((field) => [
      field,
      values[field],
    ])
  )
  return { items: [{ id: row.id, ...changedFields }] }
}

export default function ListingCopySheet({
  open,
  row,
  onClose,
  onSaved,
}: {
  open: boolean
  row: ListingCopyRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const { notify } = useNotifications()
  const [initialValues, setInitialValues] = useState<CopyValues | null>(null)
  const [values, setValues] = useState<CopyValues | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !row) return
    const next = valuesFromRow(row)
    setInitialValues(next)
    setValues(next)
  }, [open, row])

  const updateValue = (field: CopyField, value: string) => {
    setValues((current: CopyValues | null) => (current ? { ...current, [field]: value } : current))
  }

  const handleSave = async () => {
    if (!row || !values || !initialValues) return
    const payload = buildListingCopyPayload(row, values)
    if (Object.keys(payload.items[0]).length === 1) {
      onClose()
      return
    }

    setSaving(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/batch-update-listing-copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error('保存失败')
      notify({ type: 'success', title: '产品文案已保存' })
      onSaved()
    } catch (error) {
      notify({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '产品文案保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(nextOpen: boolean) => !nextOpen && onClose()}>
      <SheetContent className="w-full max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>编辑产品文案{row ? ` · ${row.sku}` : ''}</SheetTitle>
        </SheetHeader>
        {values ? (
          <div className="mt-6 space-y-5">
            <div className="space-y-2">
              <label htmlFor="listing-title" className="text-sm font-medium">标题</label>
              <Input
                id="listing-title"
                value={values.listing_title}
                onChange={(event: ChangeEvent<HTMLInputElement>) => updateValue('listing_title', event.target.value)}
                placeholder="输入商品标题"
              />
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">五点描述</p>
                <p className="mt-1 text-xs text-muted-foreground">每一点独立维护，清空后会从商品文案中移除。</p>
              </div>
              {([1, 2, 3, 4, 5] as const).map((number) => {
                const field = `listing_bullet_${number}` as CopyField
                return (
                  <div key={field} className="space-y-1.5">
                    <label htmlFor={field} className="text-xs text-muted-foreground">第 {number} 点</label>
                    <Input
                      id={field}
                      value={values[field]}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => updateValue(field, event.target.value)}
                      placeholder={`输入第 ${number} 点描述`}
                    />
                  </div>
                )
              })}
            </div>
            <div className="space-y-2">
              <label htmlFor="listing-description" className="text-sm font-medium">Description</label>
              <Textarea
                id="listing-description"
                value={values.listing_description}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateValue('listing_description', event.target.value)}
                placeholder="输入 Description"
                className="min-h-[120px]"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="listing-selling-points" className="text-sm font-medium">卖点提炼</label>
              <Textarea
                id="listing-selling-points"
                value={values.listing_selling_points}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateValue('listing_selling_points', event.target.value)}
                placeholder="输入卖点提炼"
                className="min-h-[100px]"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>取消</Button>
              <Button type="button" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中...' : '保存文案'}
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

export { COPY_FIELDS }
export type { CopyField, CopyValues, ListingCopyRow }

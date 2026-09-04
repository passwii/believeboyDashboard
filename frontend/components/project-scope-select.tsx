'use client'

import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MultiSelect, type Option as MultiSelectOption } from '@/components/ui/multi-select'

/**
 * 项目范围多选控件（BLF-441 提升为共享组件，原位于 scheduled-reports/_components）
 * - 三态合一：'*'（全部项目）/ []（空）/ ['id1','id2',...]（具体项目）
 * - 顶部一个「☑️ 全部项目」首选项；勾选后禁用 MultiSelect
 * - 在 MultiSelect 上勾任意具体项目，自动取消「全部项目」
 * - 提交时把空串归一为 '*'（由调用方在提交处归一，确保后端拿到的永远是合法值）
 */
export function ProjectScopeSelect({
  value,
  selectedIds,
  onValueChange,
  onSelectedIdsChange,
  projects,
  disabled = false,
  allHint = '当前聚合所有项目的数据',
  specificHint,
}: {
  value: string
  selectedIds: string[]
  onValueChange: (v: string) => void
  onSelectedIdsChange: (ids: string[]) => void
  projects: Array<{ id?: number | null; name: string }>
  disabled?: boolean
  /** 「全部项目」选中时右侧提示文案 */
  allHint?: string
  /** 未选任何项目时的提示文案（缺省由 selectedIds 推导） */
  specificHint?: string
}) {
  const isAll = value === '*'
  const options: MultiSelectOption[] = useMemo(
    () =>
      projects
        .filter((p) => p.id != null)
        .map((p) => ({ value: String(p.id), label: p.name })),
    [projects]
  )

  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      onValueChange('*')
      onSelectedIdsChange([])
    } else {
      onValueChange(selectedIds.length > 0 ? selectedIds.join(',') : '')
    }
  }

  const handleIdsChange = (next: string[]) => {
    onSelectedIdsChange(next)
    if (next.length === 0) {
      onValueChange('')
    } else {
      onValueChange(next.join(','))
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => handleToggleAll(!isAll)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors',
          'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          isAll && 'bg-accent'
        )}
      >
        <div
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-sm border',
            isAll ? 'bg-primary border-primary text-primary-foreground' : 'border-input'
          )}
        >
          {isAll && <Check className="h-3 w-3" />}
        </div>
        <span className="font-medium">全部项目</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {isAll
            ? allHint
            : selectedIds.length > 0
              ? `已选 ${selectedIds.length} 个项目合并`
              : (specificHint ?? '请选择具体项目')}
        </span>
      </button>
      <MultiSelect
        options={options}
        selected={selectedIds}
        onChange={handleIdsChange}
        placeholder="选择具体项目..."
        className={cn(isAll && 'opacity-50 pointer-events-none')}
      />
    </div>
  )
}

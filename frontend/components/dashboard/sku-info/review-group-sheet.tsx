'use client'

import { useCallback, useEffect, useId, useMemo, useState, type ComponentProps } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'

import { useConfirm } from '@/hooks/use-confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useNotifications } from '@/components/notifications'
import { getCountryLabel } from '@/lib/country'
import { WarmSelect, type WarmSelectOption } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  type ReviewGroup,
  ReviewTrackingApiError,
  createReviewGroup,
  deactivateReviewGroup,
  describeReviewTrackingError,
  fetchReviewGroups,
  patchReviewGroup,
} from '@/lib/review-tracking-api'

/**
 * 内部评论共享组维护 Sheet（阶段 C，BLF-1377，补齐阶段 A 遗留）。
 *
 * 域规则（设计稿 §8.1 / 阶段 A 计划）：
 *  - 成员必须是同 Project + Marketplace 下的现有 SKU 记录（`product_costs.id`）；
 *  - 代表 ASIN 必须是当前组的有效成员；
 *  - 组停用会释放其有效成员（历史成员行保留），之后 SKU 才能加入其他组；
 *  - `PATCH /groups/{id}` 不接受 `member_ids` / `representative_id` / `name` 为 null，
 *    所以 UI 不允许提交空成员或空代表。
 *
 * 写操作仅管理员（后端 403）；非管理员进不来（入口按 isAdmin 隐藏），
 * 但若直接调用仍按 403 文案提示。
 */
export interface SkuCandidate {
  id: number
  sku: string
  asin: string
  productName: string | null
}

export interface ReviewGroupSheetProps {
  open: boolean
  onClose: () => void
  /** 当前 SKU 行所属项目（项目名 → 后端用 project_id） */
  projectId: number | null
  projectName: string
  /** 当前 SKU 行所属站点 */
  marketplace: string
  /** 当前项目 + 站点下的候选 SKU（含当前行） */
  candidates: SkuCandidate[]
  /** 当前行 SKU 记录 id，用于建组时默认选中 */
  currentSkuId: number | null
  onChanged?: () => void
  portalContainer?: HTMLElement | null
  contentClassName?: string
  memberPickerClassName?: string
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus']
}

interface GroupFormState {
  name: string
  description: string
  memberIds: string[]
  representativeId: string
}

const EMPTY_FORM: GroupFormState = {
  name: '',
  description: '',
  memberIds: [],
  representativeId: '',
}

function MemberPicker({
  options,
  selected,
  onChange,
  portalContainer,
  contentClassName,
}: {
  options: ReadonlyArray<WarmSelectOption>
  selected: string[]
  onChange: (values: string[]) => void
  portalContainer?: HTMLElement | null
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const optionByValue = new Map(options.map((option) => [option.value, option]))
  const selectedEntries = selected.map((value) => ({
    value,
    label: optionByValue.get(value)?.label ?? `#${value}`,
  }))

  const toggleValue = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((current) => current !== value)
        : [...selected, value]
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="space-y-2">
        {selectedEntries.length > 0 ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="已选成员 SKU">
            {selectedEntries.slice(0, 2).map((option) => (
              <span key={option.value} className="review-member-token">
                <span>{option.label}</span>
                <button
                  type="button"
                  aria-label={`移除成员 SKU ${option.label}`}
                  onClick={() => toggleValue(option.value)}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
            {selectedEntries.length > 2 ? (
              <span className="review-member-count">+{selectedEntries.length - 2}</span>
            ) : null}
          </div>
        ) : null}
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-label="选择成员 SKU"
            aria-controls={listId}
            aria-expanded={open}
            className="warm-ledger__select review-member-trigger"
          >
            <span>{selected.length ? `已选 ${selected.length} 个成员 SKU` : '选择成员 SKU'}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        portalContainer={portalContainer}
        align="start"
        className={contentClassName}
      >
        <Command>
          <CommandInput placeholder="搜索..." />
          <CommandList id={listId}>
            <CommandEmpty>没有找到</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => toggleValue(option.value)}
                >
                  <span
                    className="review-member-check"
                    data-selected={selected.includes(option.value) ? 'true' : undefined}
                    aria-hidden="true"
                  >
                    {selected.includes(option.value) ? <Check /> : null}
                  </span>
                  <span>{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 ? (
            <div className="review-member-clear">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange([])
                  setOpen(false)
                }}
              >
                清除全部
              </Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default function ReviewGroupSheet({
  open,
  onClose,
  projectId,
  projectName,
  marketplace,
  candidates,
  currentSkuId,
  onChanged,
  portalContainer,
  contentClassName,
  memberPickerClassName,
  onCloseAutoFocus,
}: ReviewGroupSheetProps) {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [groups, setGroups] = useState<ReviewGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<GroupFormState>(EMPTY_FORM)
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)
  /** 编辑中组在打开表单时的**原代表**（用于判断「是否把旧代表移出成员」这个中间态）。 */
  const [editingRepresentativeId, setEditingRepresentativeId] = useState<number | null>(null)

  const candidateById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates]
  )

  const memberOptions = useMemo(
    () =>
      candidates.map((candidate) => ({
        value: String(candidate.id),
        label: `${candidate.sku} · ${candidate.asin}${candidate.productName ? ` · ${candidate.productName}` : ''}`,
      })),
    [candidates]
  )

  const loadGroups = useCallback(async () => {
    if (projectId === null) return
    setLoading(true)
    try {
      const rows = await fetchReviewGroups({
        projectId,
        marketplace,
        isActive: true,
      })
      setGroups(rows)
    } catch (error) {
      const described = describeReviewTrackingError(error)
      notify({ type: 'error', title: described.title, message: described.message })
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [marketplace, notify, projectId])

  useEffect(() => {
    if (!open) return
    setEditingGroupId(null)
    setEditingRepresentativeId(null)
    setForm(
      currentSkuId !== null
        ? { ...EMPTY_FORM, memberIds: [String(currentSkuId)], representativeId: String(currentSkuId) }
        : EMPTY_FORM
    )
    void loadGroups()
  }, [currentSkuId, loadGroups, open])

  /** 代表 ASIN 必须属于已选成员——成员变化时把失效的代表清掉。 */
  const updateMemberIds = (values: string[]) => {
    setForm((current) => ({
      ...current,
      memberIds: values,
      representativeId: values.includes(current.representativeId) ? current.representativeId : '',
    }))
  }

  const representativeOptions = form.memberIds
    .map((id) => candidateById.get(Number(id)))
    .filter((candidate): candidate is SkuCandidate => Boolean(candidate))
    .map((candidate) => ({
      value: String(candidate.id),
      label: `${candidate.sku} · ${candidate.asin}`,
    }))

  const startEdit = (group: ReviewGroup) => {
    setEditingGroupId(group.id)
    setEditingRepresentativeId(group.representativeId)
    setForm({
      name: group.name,
      description: group.description ?? '',
      memberIds: group.memberIds.map(String),
      representativeId: group.representativeId !== null ? String(group.representativeId) : '',
    })
  }

  const resetForm = () => {
    setEditingGroupId(null)
    setEditingRepresentativeId(null)
    setForm(EMPTY_FORM)
  }

  const submit = async () => {
    if (projectId === null) {
      notify({ type: 'error', title: '缺少项目信息，无法维护共享组' })
      return
    }
    if (!form.name.trim()) {
      notify({ type: 'error', title: '组名不能为空' })
      return
    }
    if (form.name.trim().length > 255) {
      notify({ type: 'error', title: '组名不能超过 255 个字符' })
      return
    }
    if (form.memberIds.length === 0) {
      notify({ type: 'error', title: '至少选择一个成员 SKU' })
      return
    }
    if (!form.representativeId) {
      notify({ type: 'error', title: '请指定代表 ASIN' })
      return
    }
    if (!form.memberIds.includes(form.representativeId)) {
      notify({ type: 'error', title: '代表 ASIN 必须是本组成员' })
      return
    }

    setSaving(true)
    const name = form.name.trim()
    const description = form.description.trim() ? form.description.trim() : null
    const memberIds = form.memberIds.map(Number)
    const representativeId = Number(form.representativeId)
    try {
      if (editingGroupId !== null) {
        /**
         * 后端 `PATCH /groups/{id}` 按 name → description → member_ids → representative_id
         * 固定顺序落字段，且 `replace_group_members` 校验的是**中间态**（当前代表必须仍在成员内）。
         * 所以「移出旧代表 + 指定新代表」如果一次提交，成员先落（旧代表已不在）→ 必现 422，
         * 而错误文案「set representative first」也走不通（新代表还不是成员）。
         * 前端拆两次 PATCH 即可满足两个中间态：
         *   1) 成员 = 最终成员 ∪ {旧代表}，同时把代表切成新代表；
         *   2) 成员 = 最终成员（此时当前代表已是新代表，仍在成员内）。
         */
        const staleRepresentative =
          editingRepresentativeId !== null &&
          editingRepresentativeId !== representativeId &&
          !memberIds.includes(editingRepresentativeId)

        if (staleRepresentative) {
          await patchReviewGroup(editingGroupId, {
            name,
            description,
            memberIds: [...memberIds, editingRepresentativeId],
            representativeId,
          })
          await patchReviewGroup(editingGroupId, { memberIds })
        } else {
          await patchReviewGroup(editingGroupId, {
            name,
            description,
            memberIds,
            representativeId,
          })
        }
        notify({ type: 'success', title: '共享组已更新' })
      } else {
        await createReviewGroup({
          projectId,
          marketplace,
          name: form.name.trim(),
          description: form.description.trim() || null,
          memberIds: form.memberIds.map(Number),
          representativeId: Number(form.representativeId),
        })
        notify({ type: 'success', title: '共享组已创建' })
      }
      resetForm()
      await loadGroups()
      onChanged?.()
    } catch (error) {
      if (error instanceof ReviewTrackingApiError && error.status === 409) {
        notify({
          type: 'error',
          title: '共享组冲突',
          message: '同项目 + 站点下已存在同名组，或某个 SKU 已在其他有效组中。',
        })
      } else {
        const described = describeReviewTrackingError(error)
        notify({ type: 'error', title: described.title, message: described.message })
      }
    } finally {
      setSaving(false)
    }
  }

  const deactivate = async (group: ReviewGroup) => {
    const confirmed = await confirm({
      title: `停用共享组「${group.name}」？`,
      description:
        '停用后该组不再作为追踪目标，成员会被释放（可直接加入其他组）；历史成员记录与已采集数据保留。',
      confirmText: '停用',
      variant: 'destructive',
    })
    if (!confirmed) return

    setSaving(true)
    try {
      await deactivateReviewGroup(group.id)
      notify({ type: 'success', title: '共享组已停用' })
      if (editingGroupId === group.id) resetForm()
      await loadGroups()
      onChanged?.()
    } catch (error) {
      const described = describeReviewTrackingError(error)
      notify({ type: 'error', title: described.title, message: described.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        portalContainer={portalContainer}
        onCloseAutoFocus={onCloseAutoFocus}
        className={['w-full overflow-y-auto sm:max-w-[720px]', contentClassName]
          .filter(Boolean)
          .join(' ')}
      >
        <SheetHeader>
          <SheetTitle>评论共享组</SheetTitle>
          <SheetDescription>
            {projectName} · {getCountryLabel(marketplace)} ·{' '}
            {editingGroupId === null ? '新建或编辑内部共享组' : `正在编辑 #${editingGroupId}`}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <section className="space-y-2 border border-term-border bg-term-panel p-3">
            <div className="flex items-center justify-between">
              <p className="review-section-label">
                {editingGroupId === null ? '新建共享组' : '编辑共享组'}
              </p>
              {editingGroupId !== null ? (
                <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                  取消编辑
                </Button>
              ) : null}
            </div>

            <Input
              className="h-9"
              placeholder="组名（同项目 + 站点内唯一）"
              aria-label="组名"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />

            <Textarea
              size="sm"
              placeholder="说明（可选）"
              aria-label="说明"
              value={form.description}
              onChange={(event) =>
                setForm((current) => ({ ...current, description: event.target.value }))
              }
            />

            <div className="space-y-1">
              <p className="font-mono text-[10px] text-term-muted">成员 SKU（同项目 + 站点）</p>
              <MemberPicker
                options={memberOptions}
                selected={form.memberIds}
                onChange={updateMemberIds}
                portalContainer={portalContainer}
                contentClassName={memberPickerClassName}
              />
            </div>

            <div className="space-y-1">
              <p className="font-mono text-[10px] text-term-muted">代表 ASIN（必须是成员）</p>
              <WarmSelect
                id="review-group-representative"
                label="代表 ASIN"
                value={form.representativeId}
                options={representativeOptions}
                placeholder="先选择成员，再指定代表"
                className="review-representative-select"
                onChange={(value) =>
                  setForm((current) => ({ ...current, representativeId: value }))
                }
                disabled={representativeOptions.length === 0}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" disabled={saving} onClick={() => void submit()}>
                {editingGroupId === null ? '创建共享组' : '保存修改'}
              </Button>
            </div>
            <p className="font-mono text-[10px] text-term-faint">
              同一 SKU 只能属于一个有效共享组；调整组成员不会自动合并或迁移历史数据。
            </p>
          </section>

          <section className="space-y-2">
            <p className="review-section-label">
              当前有效共享组（{groups.length}）
            </p>
            {loading ? (
              <Skeleton className="h-20 w-full rounded-none" />
            ) : groups.length === 0 ? (
              <EmptyState icon="database" message="该站点下还没有评论共享组" />
            ) : (
              <ul className="space-y-2">
                {groups.map((group) => (
                  <li
                    key={group.id}
                    className="border border-term-border bg-term-panel p-3"
                    data-testid={`review-group-${group.id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold text-term-text">
                            {group.name}
                          </span>
                          <Badge variant="outline" className="border-term-border text-term-muted">
                            #{group.id}
                          </Badge>
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] text-term-faint">
                          代表 {candidateById.get(group.representativeId ?? -1)?.asin ?? group.representativeId ?? '未设置'}
                          {' · '}
                          成员 {group.memberIds.length} 个
                        </p>
                        {group.description ? (
                          <p className="mt-1 text-[11px] text-term-muted">{group.description}</p>
                        ) : null}
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => startEdit(group)}>
                          编辑
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={saving}
                          onClick={() => void deactivate(group)}
                        >
                          停用
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1 break-all font-mono text-[10px] text-term-faint">
                      {group.memberIds
                        .map((id) => candidateById.get(id)?.asin ?? `#${id}`)
                        .join(' / ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

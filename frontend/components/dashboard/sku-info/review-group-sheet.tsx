'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useConfirm } from '@/hooks/use-confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { MultiSelect } from '@/components/ui/multi-select'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

export default function ReviewGroupSheet({
  open,
  onClose,
  projectId,
  projectName,
  marketplace,
  candidates,
  currentSkuId,
  onChanged,
}: ReviewGroupSheetProps) {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [groups, setGroups] = useState<ReviewGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<GroupFormState>(EMPTY_FORM)
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)

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
    setForm({
      name: group.name,
      description: group.description ?? '',
      memberIds: group.memberIds.map(String),
      representativeId: group.representativeId !== null ? String(group.representativeId) : '',
    })
  }

  const resetForm = () => {
    setEditingGroupId(null)
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
    try {
      if (editingGroupId !== null) {
        await patchReviewGroup(editingGroupId, {
          name: form.name.trim(),
          description: form.description.trim() ? form.description.trim() : null,
          memberIds: form.memberIds.map(Number),
          representativeId: Number(form.representativeId),
        })
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
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[720px]">
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
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-term-muted">
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
              <MultiSelect
                options={memberOptions}
                selected={form.memberIds}
                onChange={updateMemberIds}
                placeholder="选择成员 SKU"
                className="w-full"
              />
            </div>

            <div className="space-y-1">
              <p className="font-mono text-[10px] text-term-muted">代表 ASIN（必须是成员）</p>
              <Select
                value={form.representativeId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, representativeId: value }))
                }
                disabled={representativeOptions.length === 0}
              >
                <SelectTrigger className="h-9" aria-label="代表 ASIN">
                  <SelectValue placeholder="先选择成员，再指定代表" />
                </SelectTrigger>
                <SelectContent>
                  {representativeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-term-muted">
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
                          <span className="truncate font-mono text-[12px] font-semibold text-term-text">
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
                    <p className="mt-1 truncate font-mono text-[10px] text-term-faint">
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

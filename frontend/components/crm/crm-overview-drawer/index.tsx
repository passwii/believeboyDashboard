'use client'

import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { CrmDetailCard } from '@/components/crm/crm-detail-card'
import { CrmValueProfileCard } from '@/components/crm/crm-value-profile-card'
import { CrmFollowTimeline } from '@/components/crm/crm-follow-timeline'
import { CrmContactList } from '@/components/crm/crm-contact-list'
import { CrmAuditTimeline } from '@/components/crm/crm-audit-timeline'
import { cn } from '@/lib/utils'
import type { CustomerInput } from '@/lib/crm/types/customer'
import type { CrmOverviewDrawerProps } from './types'

// 懒加载表单（含 react-hook-form + zod resolver），避免在仅需详情/跟进时
// 拖入重型依赖；也便于测试隔离。
const CrmFormCreate = lazy(() =>
  import('@/components/crm/crm-form-create').then((m) => ({ default: m.CrmFormCreate }))
)

/**
 * 通用详情抽屉（v1.2）：详情 Tab（crm-detail-card，按 FIELD_DEFS 渲染）
 * + 跟进 Tab（crm-follow-timeline，多态复用）+ 编辑 Tab（crm-form-create）。
 * 客户/线索/商机复用同一抽屉，仅换 entityType / fields / onSave。
 */
export function CrmOverviewDrawer<T extends object>({
  open,
  onOpenChange,
  entityType,
  entityId,
  data,
  fields,
  title,
  headerExtra,
  actions,
  editForm,
  users,
  loadFollows,
  createFollow,
  onSave,
}: CrmOverviewDrawerProps<T>) {
  const { notify } = useNotifications()
  const [follows, setFollows] = useState<import('@/lib/crm/types/follow').Follow[]>([])
  const [followLoading, setFollowLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const isCustomer = entityType === 'customer'

  const refreshFollows = useCallback(async () => {
    setFollowLoading(true)
    try {
      setFollows(await loadFollows(entityType, entityId))
    } finally {
      setFollowLoading(false)
    }
  }, [loadFollows, entityType, entityId])

  useEffect(() => {
    if (open && entityId) {
      setEditing(false)
      void refreshFollows()
    }
  }, [open, entityId, refreshFollows])

  async function handleFollowSubmit(value: {
    type: import('@/lib/crm/types/follow').FollowType
    content: string
    nextFollowAt?: string
  }) {
    await createFollow({
      entityType,
      entityId,
      type: value.type,
      content: value.content,
      nextFollowAt: value.nextFollowAt,
      createdBy: 'current-user',
    })
    notify({ type: 'success', title: '跟进已添加' })
    await refreshFollows()
  }

  async function handleSave(input: CustomerInput) {
    await onSave(input)
    notify({ type: 'success', title: '已保存' })
    setEditing(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center justify-between gap-2 pr-8">
            <SheetTitle className="truncate">{title}</SheetTitle>
            <div className="flex items-center gap-2">
              {actions}
              {headerExtra}
            </div>
          </div>
        </SheetHeader>

        <Tabs defaultValue="detail" className="flex h-full flex-col">
          <div className="px-5 pt-3">
            <TabsList className={cn('grid w-full', isCustomer ? 'grid-cols-5' : 'grid-cols-4')}>
              <TabsTrigger value="detail">详情</TabsTrigger>
              <TabsTrigger value="follow">跟进</TabsTrigger>
              {isCustomer && <TabsTrigger value="contacts">联系人</TabsTrigger>}
              <TabsTrigger value="audit">操作记录</TabsTrigger>
              <TabsTrigger value="edit">编辑</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <TabsContent value="detail" className="mt-0">
              {entityType === 'customer' && (
                <div className="mb-4">
                  <CrmValueProfileCard customer={data as any} />
                </div>
              )}
              <CrmDetailCard fields={fields} data={data as Record<string, unknown>} />
            </TabsContent>

            <TabsContent value="follow" className="mt-0">
              {followLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : (
                <CrmFollowTimeline
                  entityType={entityType}
                  entityId={entityId}
                  follows={follows}
                  onSubmit={handleFollowSubmit}
                />
              )}
            </TabsContent>

            {isCustomer && (
              <TabsContent value="contacts" className="mt-0">
                <CrmContactList customerId={entityId} />
              </TabsContent>
            )}

            <TabsContent value="audit" className="mt-0">
              <CrmAuditTimeline entityType={entityType} entityId={entityId} />
            </TabsContent>

            <TabsContent value="edit" className="mt-0">
              {editForm ? (
                editForm
              ) : editing ? (
                <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                  <CrmFormCreate
                    users={users}
                    initialValues={data as Record<string, never>}
                    onSubmit={handleSave}
                    submitText="保存修改"
                  />
                </Suspense>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    点击下方按钮进入编辑模式，修改客户基础信息。
                  </p>
                  <Button onClick={() => setEditing(true)}>编辑信息</Button>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

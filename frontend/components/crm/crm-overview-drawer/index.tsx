'use client'

import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  FileStack,
  FileText,
  History,
  ListTodo,
  Pencil,
  PhoneCall,
  Users,
} from 'lucide-react'
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
import { CrmCategoryField } from '@/components/crm/crm-category-field'
import { CrmFollowTimeline } from '@/components/crm/crm-follow-timeline'
import { CrmContactList } from '@/components/crm/crm-contact-list'
import { CrmAuditTimeline } from '@/components/crm/crm-audit-timeline'
import { CrmTaskTab } from '@/components/crm/crm-task-tab'
import { CustomerProposals } from '@/components/crm/proposal/customer-proposals'
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
 * 客户额外有「方案」Tab（该客户关联的客户方案，只读 + 跳详情）。
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
      {/* BLF-837：抽屉终端规格——零圆角、term 边界与面板底色 */}
      <SheetContent className="w-full gap-0 rounded-none border-term-border bg-term-panel p-0 sm:max-w-xl">
        <SheetHeader className="rounded-none border-b border-term-border px-3 py-2">
          <div className="flex items-center justify-between gap-2 pr-8">
            <SheetTitle className="truncate text-sm uppercase tracking-wider text-term-muted">
              {title}
            </SheetTitle>
            <div className="flex items-center gap-1.5">
              {actions}
              {headerExtra}
            </div>
          </div>
        </SheetHeader>

        <Tabs defaultValue="detail" className="flex h-full flex-col">
          <div className="px-5 pt-3">
            {/* 移动规则（总则 1/2）：客户 7 个 tab 手机端 4 列×2 行、线索/商机 5 个
                （sm+ 恢复单行横排）；BLF-883 全局统一 variant="term" + 前置 icon，
                h-auto 容纳换行。 */}
            <TabsList
              variant="term"
              className={cn(
                'grid h-auto w-full grid-cols-4 sm:grid-cols-7',
                !isCustomer && 'sm:grid-cols-5'
              )}
            >
              <TabsTrigger value="detail" variant="term">
                <FileText aria-hidden />
                详情
              </TabsTrigger>
              {isCustomer && (
                <TabsTrigger value="proposals" variant="term">
                  <FileStack aria-hidden />
                  方案
                </TabsTrigger>
              )}
              <TabsTrigger value="follow" variant="term">
                <PhoneCall aria-hidden />
                跟进
              </TabsTrigger>
              {isCustomer && (
                <TabsTrigger value="contacts" variant="term">
                  <Users aria-hidden />
                  联系人
                </TabsTrigger>
              )}
              <TabsTrigger value="tasks" variant="term">
                <ListTodo aria-hidden />
                任务
              </TabsTrigger>
              <TabsTrigger value="audit" variant="term">
                <History aria-hidden />
                操作记录
              </TabsTrigger>
              <TabsTrigger value="edit" variant="term">
                <Pencil aria-hidden />
                编辑
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <TabsContent value="detail" className="mt-0">
              {entityType === 'customer' && (
                <div className="mb-3">
                  <CrmValueProfileCard customer={data as any} />
                  <div className="mt-1.5 border border-term-border bg-term-raised px-3 py-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-mono text-xs uppercase tracking-wider text-term-muted">
                        产品类目
                      </span>
                    </div>
                    <CrmCategoryField customer={data as any} />
                  </div>
                </div>
              )}
              <CrmDetailCard fields={fields} data={data as Record<string, unknown>} />
            </TabsContent>

            {isCustomer && (
              <TabsContent value="proposals" className="mt-0">
                <CustomerProposals customerId={entityId} />
              </TabsContent>
            )}

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

            <TabsContent value="tasks" className="mt-0">
              <CrmTaskTab entityType={entityType} entityId={entityId} />
            </TabsContent>

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
                  <p className="font-mono text-xs text-term-faint">
                    点击下方按钮进入编辑模式，修改客户基础信息。
                  </p>
                  <Button className="rounded-none border border-term-border bg-term-panel font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text" variant="outline" size="sm" onClick={() => setEditing(true)}>编辑信息</Button>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

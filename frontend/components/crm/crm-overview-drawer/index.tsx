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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WarmCrmRecordDrawer } from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
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

import styles from './crm-overview-drawer-warm.module.css'

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
    <WarmCrmRecordDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      actions={
        <>
          {actions}
          {headerExtra}
        </>
      }
    >
      <Tabs defaultValue="detail" className={styles.tabs}>
        <TabsList
          data-warm-crm-tabs
          className={cn(
            styles.tabList,
            isCustomer ? styles.tabListCustomer : styles.tabListEntity
          )}
        >
          <TabsTrigger value="detail" className={styles.tab}>
            <FileText aria-hidden />
            详情
          </TabsTrigger>
          {isCustomer && (
            <TabsTrigger value="proposals" className={styles.tab}>
              <FileStack aria-hidden />
              方案
            </TabsTrigger>
          )}
          <TabsTrigger value="follow" className={styles.tab}>
            <PhoneCall aria-hidden />
            跟进
          </TabsTrigger>
          {isCustomer && (
            <TabsTrigger value="contacts" className={styles.tab}>
              <Users aria-hidden />
              联系人
            </TabsTrigger>
          )}
          <TabsTrigger value="tasks" className={styles.tab}>
            <ListTodo aria-hidden />
            任务
          </TabsTrigger>
          <TabsTrigger value="audit" className={styles.tab}>
            <History aria-hidden />
            操作记录
          </TabsTrigger>
          <TabsTrigger value="edit" className={styles.tab}>
            <Pencil aria-hidden />
            编辑
          </TabsTrigger>
        </TabsList>

        <div className={styles.content}>
          <TabsContent value="detail" className="mt-0">
            <div className={styles.detailStack}>
              {entityType === 'customer' && (
                <>
                  <CrmValueProfileCard customer={data as any} />
                  <div className={styles.categoryPanel}>
                    <h3 className={styles.categoryTitle}>产品类目</h3>
                    <CrmCategoryField customer={data as any} />
                  </div>
                </>
              )}
              <CrmDetailCard fields={fields} data={data as Record<string, unknown>} />
            </div>
          </TabsContent>

          {isCustomer && (
            <TabsContent value="proposals" className="mt-0">
              <div className={styles.legacySurface}>
                <CustomerProposals customerId={entityId} />
              </div>
            </TabsContent>
          )}

          <TabsContent value="follow" className="mt-0">
            <CrmFollowTimeline
              entityType={entityType}
              entityId={entityId}
              follows={follows}
              loading={followLoading}
              onSubmit={handleFollowSubmit}
            />
          </TabsContent>

          {isCustomer && (
            <TabsContent value="contacts" className="mt-0">
              <CrmContactList customerId={entityId} />
            </TabsContent>
          )}

          <TabsContent value="tasks" className="mt-0">
            <div className={styles.legacySurface}>
              <CrmTaskTab entityType={entityType} entityId={entityId} />
            </div>
          </TabsContent>

          <TabsContent value="audit" className="mt-0">
            <div className={styles.legacySurface}>
              <CrmAuditTimeline entityType={entityType} entityId={entityId} />
            </div>
          </TabsContent>

          <TabsContent value="edit" className="mt-0">
            {editForm ? (
              editForm
            ) : editing ? (
              <Suspense
                fallback={
                  <div className={styles.formLoading} role="status" aria-label="表单加载中">
                    <span aria-hidden="true" />
                  </div>
                }
              >
                <CrmFormCreate
                  users={users}
                  initialValues={data as Record<string, never>}
                  onSubmit={handleSave}
                  submitText="保存修改"
                />
              </Suspense>
            ) : (
              <div className={styles.editAction}>
                <WarmButton onClick={() => setEditing(true)}>编辑信息</WarmButton>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </WarmCrmRecordDrawer>
  )
}

# P1 计划：前端配置页面（Drawer 抽屉）

> 目标：实现独立的"项目背景配置"抽屉组件，运营人员可在项目信息页面进入并编辑背景配置

---

## 步骤概览

```
P1
├── 1.1 API 调用层
├── 1.2 Drawer 组件结构
├── 1.3 维度卡片组件
├── 1.4 SKU 特殊状态管理
├── 1.5 项目信息页面集成
└── 1.6 权限控制
```

---

## 1.1 API 调用层

**目标**：封装前端 API 调用函数

**文件**：`frontend/lib/project-context.ts`

**新增函数**：

```typescript
const API_BASE = '/api/backend'

type ProjectContextResponse = {
  project_id: number
  project_name: string
  project_context: Record<string, any> | null
  sku_context: Record<string, any> | null
}

type ProjectContextUpdate = {
  project_context?: Record<string, any>
  sku_context?: Record<string, any>
}

export async function fetchProjectContext(
  projectId: number,
  session: Session | null
): Promise<ProjectContextResponse> {
  const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context`, {
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch project context: ${response.statusText}`)
  }
  return response.json()
}

export async function updateProjectContext(
  projectId: number,
  payload: ProjectContextUpdate,
  session: Session | null
): Promise<ProjectContextResponse> {
  const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`Failed to update project context: ${response.statusText}`)
  }
  return response.json()
}
```

**验证方式**：
```typescript
// 编译检查
npx tsc --noEmit lib/project-context.ts
```

---

## 1.2 Drawer 组件结构

**目标**：创建主容器组件 `ProjectContextDrawer`

**文件**：`frontend/components/dashboard/project-context-drawer.tsx`

**组件结构**：

```typescript
'use client'

import { useState, useEffect } from 'react'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from '@/components/ui/drawer' // 复用现有 Drawer 组件
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { useGlobalLoading } from '@/components/global-loading-provider'

import { fetchProjectContext, updateProjectContext } from '@/lib/project-context'
import { FactoryCard } from './cards/factory-card'
import { SeasonalityCard } from './cards/seasonality-card'
import { GrowthCard } from './cards/growth-card'
import { StatusCard } from './cards/status-card'
import { SkuContextCard } from './cards/sku-context-card'
import { NotesCard } from './cards/notes-card'

type ProjectContextDrawerProps = {
  projectId: number
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function ProjectContextDrawer({
  projectId,
  projectName,
  open,
  onOpenChange,
  onSuccess,
}: ProjectContextDrawerProps) {
  const { notify } = useNotifications()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [context, setContext] = useState<ProjectContextResponse | null>(null)
  const [draft, setDraft] = useState<ProjectContextUpdate>({})
  const [hasChanges, setHasChanges] = useState(false)

  // 加载数据
  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetchProjectContext(projectId, null)
      .then(setContext)
      .catch((err) => notify({ type: 'error', title: '加载失败', message: err.message }))
      .finally(() => setLoading(false))
  }, [open, projectId])

  // 检测变更
  useEffect(() => {
    setHasChanges(Object.keys(draft).length > 0)
  }, [draft])

  // 保存
  const handleSave = async () => {
    setSubmitting(true)
    startGlobalLoading('blocking')
    try {
      const result = await updateProjectContext(projectId, draft, null)
      setContext(result)
      setDraft({})
      setHasChanges(false)
      notify({ type: 'success', title: '保存成功', message: '项目背景配置已更新' })
      onSuccess?.()
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: err instanceof Error ? err.message : '保存失败' })
    } finally {
      endGlobalLoading('blocking')
      setSubmitting(false)
    }
  }

  // 关闭前检查未保存
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && hasChanges) {
      const confirmed = window.confirm('有未保存的更改，确定要关闭吗？')
      if (!confirmed) return
    }
    setDraft({})
    setHasChanges(false)
    onOpenChange(newOpen)
  }

  const updateDraft = (updates: ProjectContextUpdate) => {
    setDraft((prev) => ({
      ...prev,
      ...updates,
    }))
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent className="max-w-xl">
        <DrawerHeader>
          <DrawerTitle>项目背景配置</DrawerTitle>
          <DrawerDescription>项目：{projectName}</DrawerDescription>
        </DrawerHeader>

        <div className="px-4 pb-4 space-y-4 max-h-[calc(100vh-180px)] overflow-y-auto">
          {loading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <FactoryCard
                value={context?.project_context?.factory}
                onChange={(factory) => updateDraft({ project_context: { factory } })}
              />
              <SeasonalityCard
                value={context?.project_context?.productSeasonality}
                onChange={(productSeasonality) => updateDraft({ project_context: { productSeasonality } })}
              />
              <GrowthCard
                value={context?.project_context?.productGrowth}
                onChange={(productGrowth) => updateDraft({ project_context: { productGrowth } })}
              />
              <StatusCard
                value={context?.project_context?.projectStatus}
                onChange={(projectStatus) => updateDraft({ project_context: { projectStatus } })}
              />
              <SkuContextCard
                value={context?.sku_context}
                projectId={projectId}
                onChange={(sku_context) => updateDraft({ sku_context })}
              />
              <NotesCard
                value={context?.project_context?.notes}
                onChange={(notes) => updateDraft({ project_context: { notes } })}
              />
            </>
          )}
        </div>

        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline" disabled={submitting}>
              取消
            </Button>
          </DrawerClose>
          <Button onClick={() => void handleSave()} disabled={submitting || !hasChanges}>
            {submitting ? '保存中...' : '保存配置'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}
```

**需要确认**：项目中是否已有 `Drawer` 组件？如有，直接使用；如无，需要从 shadcn/ui 引入。

---

## 1.3 维度卡片组件

**目标**：为每个维度创建可折叠的卡片组件

**文件**：
- `frontend/components/dashboard/project-context/cards/factory-card.tsx`
- `frontend/components/dashboard/project-context/cards/seasonality-card.tsx`
- `frontend/components/dashboard/project-context/cards/growth-card.tsx`
- `frontend/components/dashboard/project-context/cards/status-card.tsx`
- `frontend/components/dashboard/project-context/cards/notes-card.tsx`

**FactoryCard 示例**：

```typescript
'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'

type FactoryContext = {
  description?: string
  productionCapacity?: string
  communication?: string
}

type FactoryCardProps = {
  value: FactoryContext | null | undefined
  onChange: (value: FactoryContext) => void
}

export function FactoryCard({ value, onChange }: FactoryCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  const preview = value?.description?.slice(0, 80) || '未填写'

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 cursor-pointer"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">🏭</Badge>
          <span className="font-medium">工厂供货维度</span>
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {preview}
            </span>
          )}
          <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3 pt-0">
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">说明</label>
            <Textarea
              value={value?.description || ''}
              onChange={(e) => onChange({ ...value, description: e.target.value })}
              placeholder="例如：工厂位于深圳宝安，标准交货周期 15 天..."
              rows={3}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">生产能力</label>
            <Textarea
              value={value?.productionCapacity || ''}
              onChange={(e) => onChange({ ...value, productionCapacity: e.target.value })}
              placeholder="例如：月产能 5000 件，旺季峰值 8000 件"
              rows={2}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">沟通协作</label>
            <Textarea
              value={value?.communication || ''}
              onChange={(e) => onChange({ ...value, communication: e.target.value })}
              placeholder="例如：对接人张工，响应速度快，品质稳定"
              rows={2}
            />
          </div>
        </CardContent>
      )}
    </Card>
  )
}
```

**其他卡片**：

| 卡片 | Key | 字段 |
|------|-----|------|
| FactoryCard | `factory` | description, productionCapacity, communication |
| SeasonalityCard | `productSeasonality` | peakSeason, offSeason, restockStrategy |
| GrowthCard | `productGrowth` | description, growthDriver |
| StatusCard | `projectStatus` | description, riskNotes |
| NotesCard | `notes` | (自由文本) |

---

## 1.4 SKU 特殊状态管理

**目标**：专门的 SKU 状态管理卡片，支持新增/删除 SKU 条目

**文件**：`frontend/components/dashboard/project-context/cards/sku-context-card.tsx`

**组件功能**：

1. 展示已有的 SKU 状态列表
2. 支持新增 SKU 状态
3. 支持删除 SKU 状态
4. 支持搜索/选择已有 SKU（调用 product_costs 接口）

**组件结构**：

```typescript
'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type SkuContext = Record<string, SkuStatusItem>

type SkuStatusItem = {
  status?: string
  reason?: string
  action?: string
  startDate?: string
  endDate?: string
}

type SkuContextCardProps = {
  value: SkuContext | null | undefined
  projectId: number
  onChange: (value: SkuContext) => void
}

export function SkuContextCard({ value, onChange, projectId }: SkuContextCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [newSku, setNewSku] = useState('')

  const skuList = Object.entries(value || {})

  const handleAdd = () => {
    if (!newSku.trim()) return
    const updated = { ...value, [newSku.trim()]: { status: '', reason: '', action: '' } }
    onChange(updated)
    setNewSku('')
  }

  const handleDelete = (sku: string) => {
    const updated = { ...value }
    delete updated[sku]
    onChange(updated)
  }

  const handleUpdateSku = (sku: string, field: keyof SkuStatusItem, fieldValue: string) => {
    const updated = { ...value, [sku]: { ...value?.[sku], [field]: fieldValue } }
    onChange(updated)
  }

  const preview = skuList.length > 0 ? `${skuList.length} 个 SKU 已配置` : '未填写'

  return (
    <Card>
      <CardHeader
        className="flex flex-row items-center justify-between py-3 cursor-pointer"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">🔥</Badge>
          <span className="font-medium">SKU 特殊状态</span>
          {skuList.length > 0 && (
            <Badge variant="secondary" className="text-xs">{skuList.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <span className="text-xs text-muted-foreground">{preview}</span>
          )}
          <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-4 pt-0">
          {/* SKU 列表 */}
          {skuList.map(([sku, item]) => (
            <div key={sku} className="border rounded-lg p-3 space-y-2 relative">
              <div className="flex items-center justify-between">
                <Input
                  value={sku}
                  onChange={(e) => {
                    const newKey = e.target.value
                    if (newKey !== sku) {
                      const updated = { ...value }
                      delete updated[sku]
                      updated[newKey] = item
                      onChange(updated)
                    }
                  }}
                  placeholder="SKU 编码"
                  className="font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(sku)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">状态</label>
                  <Input
                    value={item.status || ''}
                    onChange={(e) => handleUpdateSku(sku, 'status', e.target.value)}
                    placeholder="清仓/秒杀/停产"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">开始日期</label>
                  <Input
                    type="date"
                    value={item.startDate || ''}
                    onChange={(e) => handleUpdateSku(sku, 'startDate', e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">原因</label>
                <Input
                  value={item.reason || ''}
                  onChange={(e) => handleUpdateSku(sku, 'reason', e.target.value)}
                  placeholder="简述原因"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">行动</label>
                <Input
                  value={item.action || ''}
                  onChange={(e) => handleUpdateSku(sku, 'action', e.target.value)}
                  placeholder="正在采取的措施"
                />
              </div>
            </div>
          ))}

          {/* 新增 SKU */}
          <div className="flex items-center gap-2">
            <Input
              value={newSku}
              onChange={(e) => setNewSku(e.target.value)}
              placeholder="输入 SKU 编码以新增"
              className="font-mono text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button variant="outline" onClick={handleAdd} disabled={!newSku.trim()}>
              <Plus className="h-4 w-4 mr-1" />
              新增
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
```

---

## 1.5 项目信息页面集成

**目标**：在项目信息页面操作列新增"背景配置"按钮

**文件**：`frontend/app/dashboard/system-management/project-info/page.tsx`

**改动**：

```typescript
// 1. 导入 Drawer 组件
import { ProjectContextDrawer } from '@/components/dashboard/project-context-drawer'

// 2. 新增状态
const [contextDrawerOpen, setContextDrawerOpen] = useState(false)
const [contextProjectId, setContextProjectId] = useState<number | null>(null)
const [contextProjectName, setContextProjectName] = useState('')

// 3. 新增打开函数
const openContextDrawer = (item: ProjectItem) => {
  setContextProjectId(item.id)
  setContextProjectName(item.name)
  setContextDrawerOpen(true)
}

// 4. 操作列新增按钮
<td className="border-b border-border/60 p-4 align-middle text-right">
  <div className="flex justify-end gap-1">
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => openContextDrawer(item)}
      title="项目背景配置"
    >
      <Settings className="h-4 w-4" />  {/* 或使用 Info 图标 */}
    </Button>
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={() => onOpenEdit(item)}
      disabled={submitting}
      aria-label={`编辑项目 ${item.name}`}
      title="编辑"
    >
      <PencilLine className="h-4 w-4" />
    </Button>
  </div>
</td>

// 5. 页面底部添加 Drawer 组件
{contextProjectId && (
  <ProjectContextDrawer
    projectId={contextProjectId}
    projectName={contextProjectName}
    open={contextDrawerOpen}
    onOpenChange={setContextDrawerOpen}
    onSuccess={() => {
      // 刷新项目列表（has_context 会更新）
      void loadProjects()
    }}
  />
)}
```

**可选增强**：在表格中显示"有背景"标识

```typescript
// 在项目名称列或操作列前增加小圆点
<td className="border-b border-r border-border/60 p-4 align-middle">
  <div className="flex items-center gap-2">
    {item.has_context && (
      <span className="h-2 w-2 rounded-full bg-green-500" title="已配置项目背景" />
    )}
    <span className="font-medium text-foreground">{item.name}</span>
  </div>
</td>
```

---

## 1.6 权限控制

**目标**：确保只有有权限的人可以编辑

**说明**：
- API 层权限由后端 `ensure_project_access` 保证
- 前端主要是 UI 层面的操作按钮展示（项目信息页面已集成权限逻辑）

**验证方式**：
- 非负责运营登录后，不应看到"背景配置"按钮
- Admin 可以看到所有项目的"背景配置"按钮

---

## 验证测试用例

### 1. 页面加载
- [ ] 访问项目信息页面，确认操作列新增按钮可见
- [ ] 点击按钮，Drawer 从右侧滑出

### 2. 数据加载
- [ ] Drawer 打开后显示加载状态
- [ ] 加载完成后显示各维度卡片
- [ ] 空数据时显示空白输入框

### 3. 折叠功能
- [ ] 点击卡片标题，折叠/展开正常
- [ ] 折叠时显示内容预览

### 4. 保存功能
- [ ] 修改内容后"保存配置"按钮可用
- [ ] 保存成功后显示成功通知
- [ ] 重新打开，数据已更新

### 5. SKU 管理
- [ ] 新增 SKU 条目正常
- [ ] 删除 SKU 条目正常
- [ ] 修改 SKU 信息正常

### 6. 权限
- [ ] 项目运营只能编辑自己负责的项目
- [ ] Admin 可以编辑所有项目

---

## 预计产出

完成 P1 后，运营人员可以：

| 功能 | 说明 |
|------|------|
| 入口可见 | 项目信息页面操作列有"背景配置"按钮 |
| 数据加载 | 打开 Drawer 显示现有配置 |
| 维度编辑 | 5 个维度卡片可折叠编辑 |
| SKU 管理 | 可新增/删除/编辑 SKU 特殊状态 |
| 自由备注 | 末尾有自由文本区域 |
| 保存成功 | 修改后正确保存到数据库 |
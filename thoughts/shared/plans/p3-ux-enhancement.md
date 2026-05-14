# P3 计划：体验优化

> 目标：完善细节体验，提升可发现性和易用性

---

## 步骤概览

```
P3
├── 3.1 项目列表「有背景」标识
├── 3.2 AI 洞察页面快捷入口
├── 3.3 背景配置更新提示
└── 3.4 变更历史记录（可选）
```

---

## 3.1 项目列表「有背景」标识

**目标**：在项目信息表格中显示该项目是否已配置背景信息

**文件**：`frontend/app/dashboard/system-management/project-info/page.tsx`

**改动**：

```tsx
// 在项目名称列或操作列前增加小圆点标识
{/* 表格列定义中 */ }
<th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">
  项目名称
</th>

{/* 渲染时 */ }
<td className="border-b border-r border-border/60 p-4 align-middle">
  <div className="flex items-center gap-2">
    {item.has_context && (
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-green-500"
        title="已配置项目背景"
      />
    )}
    <span className="font-medium text-foreground truncate">{item.name}</span>
  </div>
</td>
```

**样式说明**：
- 绿色小圆点表示"已配置"
- 无圆点表示"未配置"
- 鼠标悬停显示 Tooltip 提示

**验证**：
- [ ] 已配置项目显示绿色圆点
- [ ] 未配置项目无圆点
- [ ] 圆点不占用原有布局空间（使用 `shrink-0`）

---

## 3.2 AI 洞察页面快捷入口

**目标**：在 AI 洞察页面或洞察详情中增加"编辑项目背景"快捷入口

**位置选择**：
1. **洞察生成前**（推荐）：在选择项目的下拉框旁边增加一个"配置项目背景"链接
2. **洞察详情页**：在报告头部增加"项目背景"展示区和编辑入口

**方案 A：在项目选择区域增加快捷入口**

**文件**：`frontend/app/dashboard/ai-insights/page.tsx` 或相关组件

**改动示意**：

```tsx
{/* 在项目选择组件旁 */ }
<div className="flex items-center gap-2">
  <ProjectSelect value={projectId} onChange={setProjectId} />
  <Button
    variant="ghost"
    size="sm"
    onClick={() => {
      // 导航到项目信息页面的背景配置
      router.push(`/dashboard/system-management/project-info?highlight=${projectId}`)
    }}
    className="text-xs text-muted-foreground"
  >
    <Settings className="h-3 w-3 mr-1" />
    配置项目背景
  </Button>
</div>
```

**方案 B：在洞察详情中展示项目背景**

**文件**：创建新组件 `frontend/components/dashboard/insight-context-panel.tsx`

**组件功能**：
1. 在洞察详情页侧边栏展示项目背景摘要
2. 提供"编辑"按钮跳转到配置页面
3. 展示 SKU 特殊状态列表

```tsx
'use client'

import { ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type ProjectContextSummary = {
  project_id: number
  project_name: string
  project_context: Record<string, any>
  sku_context: Record<string, any>
}

type InsightContextPanelProps = {
  context: ProjectContextSummary
  onNavigateToConfig?: () => void
}

export function InsightContextPanel({ context, onNavigateToConfig }: InsightContextPanelProps) {
  const hasContext = Object.keys(context.project_context || {}).length > 0 ||
                      Object.keys(context.sku_context || {}).length > 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">项目背景</span>
          <Button variant="ghost" size="sm" onClick={onNavigateToConfig}>
            <ExternalLink className="h-3 w-3 mr-1" />
            编辑
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!hasContext ? (
          <p className="text-muted-foreground">
            暂无项目背景配置。
            <Button variant="link" className="h-auto p-0 text-xs" onClick={onNavigateToConfig}>
              去配置 →
            </Button>
          </p>
        ) : (
          <>
            {/* 项目状态概览 */}
            {context.project_context?.projectStatus && (
              <div>
                <p className="text-muted-foreground text-xs mb-1">项目状态</p>
                <p>{context.project_context.projectStatus.description}</p>
              </div>
            )}

            {/* SKU 特殊状态列表 */}
            {Object.keys(context.sku_context || {}).length > 0 && (
              <div>
                <p className="text-muted-foreground text-xs mb-1">SKU 特殊状态</p>
                <div className="space-y-1">
                  {Object.entries(context.sku_context).map(([sku, item]: [string, any]) => (
                    <div key={sku} className="flex items-center gap-2">
                      <code className="text-xs bg-muted px-1 rounded">{sku}</code>
                      {item.status && (
                        <Badge variant="outline" className="text-xs">
                          {item.status}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
```

**验证**：
- [ ] 洞察详情页显示项目背景摘要
- [ ] 点击"编辑"跳转到配置页面

---

## 3.3 背景配置更新提示

**目标**：在特定场景下提示用户更新项目背景

**场景**：

| 场景 | 提示内容 |
|------|----------|
| 生成洞察时发现 SKU 有异常销售但无背景信息 | "检测到 SKU-BB001 销量异常，是否需要配置背景信息？" |
| 项目运营超过 3 个月但无背景配置 | 在 AI 洞察页面顶部显示 Banner "建议配置项目背景以获得更准确的洞察" |

**实现方式**：

```tsx
// 在 AI Insights 页面顶部添加 Banner
function ProjectContextSuggestionBanner({ projectId, hasContext }: { projectId: number, hasContext: boolean }) {
  const [dismissed, setDismissed] = useState(false)

  if (dismissed || hasContext) return null

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-3">
      <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm text-amber-800">
          <strong>建议配置项目背景</strong>以获得更准确的 AI 洞察分析。
          AI 将结合项目背景信息（如淡旺季、工厂供货、产品增长等）进行综合判断。
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
            onClick={() => router.push(`/dashboard/system-management/project-info?configure=${projectId}`)}
          >
            去配置
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-700"
            onClick={() => setDismissed(true)}
          >
            暂不配置
          </Button>
        </div>
      </div>
    </div>
  )
}
```

**验证**：
- [ ] 未配置背景的项目显示 Banner
- [ ] 点击"去配置"跳转到配置页面
- [ ] 点击"暂不配置"隐藏 Banner（本次会话不再显示）

---

## 3.4 变更历史记录（可选）

**目标**：记录项目背景的变更历史，供审计和回溯

**可选实现**：

```sql
-- 方案 A：在 audit_logs 表中记录（已有操作审计日志）
-- projects.context.update 操作已通过 append_operation_audit_log 记录

-- 方案 B：新建专门的项目背景变更表
CREATE TABLE project_context_history (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  changed_by VARCHAR(255),
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  project_context JSONB,
  sku_context JSONB,
  change_type VARCHAR(20),  -- 'create', 'update', 'delete'
  diff JSONB  -- 可选：记录变更差异
);
```

**建议**：先使用方案 A（复用现有审计日志），后续按需迁移到方案 B。

---

## 验证测试用例

### 3.1 项目列表标识
- [ ] 已配置项目显示绿色圆点
- [ ] 未配置项目无圆点
- [ ] 刷新后状态保持

### 3.2 AI 洞察快捷入口
- [ ] 洞察详情页显示项目背景摘要
- [ ] 点击"编辑"正确跳转

### 3.3 更新提示
- [ ] 未配置项目显示 Banner
- [ ] 点击"去配置"跳转到配置页面
- [ ] 点击"暂不配置"隐藏 Banner

---

## 预计产出

完成 P3 后，用户体验更加完善：

| 功能 | 说明 |
|------|------|
| 列表标识 | 一眼看出哪些项目已配置背景 |
| 洞察展示 | AI 洞察页面可查看项目背景摘要 |
| 快捷编辑 | 洞察页面可直接跳转到配置页面 |
| 引导提示 | 未配置项目显示配置建议 |
| 变更记录 | 背景变更通过审计日志可追溯 |
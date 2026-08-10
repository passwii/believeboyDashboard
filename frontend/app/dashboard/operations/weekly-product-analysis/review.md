# Weekly Product Analysis Page — 代码 Review

## 🟡 问题 1: `authHeaders()` 返回空对象（不一致）

**位置**: `page.tsx:391-393`

```ts
function authHeaders(): Record<string, string> {
  return {}
}
```

该函数在 5 处 fetch 调用中被使用（lines 1176, 1257, 1290, 1365, 1681），但始终返回空对象。对比 `product-analysis-panel.tsx:397-398` 中正确传递了 `X-Is-Admin` 头：

```ts
const authHeaders: Record<string, string> = {}
if (isAdmin) authHeaders['X-Is-Admin'] = 'true'
```

不过，前端 proxy 层（`/api/backend/*`）会自动通过 NextAuth session 注入认证信息，**安全性和功能不受影响**。主要问题是代码风格不一致，且如果将来某天后端开始要求前端显式传递 `X-Is-Admin`，这里会静默失效。

**建议**: 要么删除这个函数（如果所有 API 调用都不需要额外头），要么对齐到 `product-analysis-panel` 的写法，按需传递 `X-Is-Admin`。

---

## 🟡 问题 2: 骨架屏状态机存在不一致的过渡行为

**位置**: `page.tsx:1405-1438`, `2338-2345`, `2745`

状态机定义：

```ts
// 有数据时切换项目 (line 1417-1426)
skeleton_visible → skeleton_fading_out (200ms过渡) → visible

// 无数据时首次加载 (line 1430-1434)
skeleton_visible → visible  （跳过 skeleton_fading_out）
```

内容 wrapper 的 opacity 由 CSS transition 控制：

```tsx
<div className={cn(
  'transition-all duration-200',
  skeletonState === 'skeleton_visible' && 'opacity-0',
  skeletonState === 'skeleton_fading_out' && 'opacity-100',
  skeletonState === 'visible' && 'opacity-100'
)}>
```

骨架屏本身由独立条件渲染控制 (line 2745)：

```tsx
{(skeletonState === 'skeleton_visible' || skeletonState === 'skeleton_fading_out') && (
  // 骨架屏内容
)}
```

**两种场景的分析**：

| 场景 | 内容 wrapper 过渡 | 骨架屏行为 |
|------|-------------------|-----------|
| 有数据时切换 | `opacity-0 → 100` (200ms 淡入) ✅ | skeleton_fading_out 时骨架屏仍显示，200ms 后 `visible` 时瞬间消失 ✅ |
| 无数据时首次加载 | `opacity-0 → 100` (200ms 淡入) ✅ | **跳过 skeleton_fading_out，骨架屏直接消失，无淡出动画** ⚠️ |

**结论**：

1. 原 review 说"没有视觉过渡"——对**内容 wrapper** 而言不成立（内容始终有 200ms 淡入）。但原 review 可能指的是骨架屏本身的"淡出"，而这个观察是对的。
2. 真正的问题是：**无数据首次加载时跳过了 `skeleton_fading_out` 状态**，骨架屏没有任何淡出，直接消失。这是设计上的不一致。
3. 状态命名误导：`skeleton_fading_out` 对应的是内容淡入（wrapper 从 0→100），而非骨架屏淡出。

**建议**: 将两种场景统一为相同的状态转换路径，在首次加载场景中也经过 `skeleton_fading_out`。

---

## ✅ 问题 3: `loadProjects` 依赖数组 — **已正确**

**位置**: `page.tsx:1113-1129`

```ts
const loadProjects = useCallback(async () => {
  setProjectsLoading(true)
  setProjectLoadError(null)
  try {
    const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
    setProjects(payload)
    if (payload.length > 0 && !projectId) {
      setProjectId(String(payload[0].id))
    }
  } catch (loadError) { ... }
}, [projectId, session])
```

`projectId` 在函数体内被读取（line 1119: `!projectId`），依赖数组中包含它是正确的 React 实践。`projectId` 变化时需要重新创建此回调以确保闭包中拿到最新值。**不存在问题**。

---

## 🟢 问题 4: 切换 tab 时 `selectedWeekId` 可能触发两次请求

**位置**: `page.tsx:1563-1574`

```ts
useEffect(() => {
  setSelectedWeekId((prev) => {
    if (prev && summaryRows.some((item) => String(item.row.id) === prev))
      return prev
    return summaryRows.length > 0 ? String(summaryRows[0].row.id) : ''
  })
}, [summaryRows])

useEffect(() => {
  if (activeTab !== 'details') return
  void loadWeeklyDetails()
}, [activeTab, loadWeeklyDetails])
```

切换项目/国家时，`summaryRows` 更新 → `selectedWeekId` 被设置 → `loadWeeklyDetails` 被调用。如果在 `selectedWeekId` 更新前组件就已经在 details tab 下，可能触发一次空值的无效调用（虽然内部有 early return）。功能性不受影响，是微小的 effect 重触发。

**建议**: 极低优先级。可通过在 `loadWeeklyDetails` 中增加 `selectedWeekId` 判空来进一步规避。

---

## 🟢 问题 5: 未使用的 import

**位置**: `page.tsx:5`

```ts
import { AlertTriangle, Download, Eye, EyeOff, Loader2, ShoppingCart } from 'lucide-react'
```

`ShoppingCart` 被导入但未在文件中使用。

**建议**: 移除。

---

## 🟢 问题 6: `trends` useMemo 的依赖链

**位置**: `page.tsx:1509-1531`

```ts
const trends = useMemo(() => {
  if (!trendRows || trendRows.length < 2) return { sales: 0, units: 0, ad: 0 }
  // ...
}, [trendRows])
```

`trendRows` 本身是 `data` 的 memo 化派生（line 1456），`trends` 依赖 `trendRows` 是间接依赖 `data`。在 `trendRows` 引用稳定时跳过重算是正确的行为。`buildSummaryTotals` 是无副作用的纯函数，不存在遗漏更新的风险。

**建议**: 无需修改。

---

## 总结

| # | 原评级 | 修正评级 | 性质 |
|---|--------|---------|------|
| 1 | 🔴 | 🟡 | 不一致，非安全问题 |
| 2 | 🔴 | 🟡 | 功能正常，命名/设计可改进 |
| 3 | 🔴 | ✅ (无问题) | 分析不准确 |
| 4 | 🟡 | 🟢 | 微小 effect 重触发 |
| 5 | 🟡 | 🟢 | 未使用导入，简单清理 |
| 6 | 🟡 | 🟢 | 依赖链正确，无需修改 |

实际真正需要关注的是 **问题 1**（一致性）和 **问题 2**（状态机设计不一致），两者均为 🟡 级别。

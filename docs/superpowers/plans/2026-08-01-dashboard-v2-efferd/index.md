# Dashboard V2（Efferd 密集网格）— 实施归档

> **状态：** ✅ **完成**（BLF-450，2026-08-05）
> **分支：** main（commit `0d5d9762` 脚手架合并 + `d10f9a4c`→`9a90f6fe` 六个实施 commit）
> **日期：** 2026-08-01（设计）→ 2026-08-05（实施完成）

## 入口

| 文档 | 路径 |
|---|---|
| 实施计划（44 步全勾选） | `2026-08-01-dashboard-v2-efferd.md` |
| 设计文档 | [`docs/superpowers/specs/2026-08-01-dashboard-v2-efferd-design.md`](../../specs/2026-08-01-dashboard-v2-efferd-design.md) |

## 任务进度

| Task | 主题 | 状态 | Commit |
|---|---|---|---|
| 1 | 脚手架（v2-card/format/grid + shadcn empty） | ✅ | `0d5d9762`（merge feat/dashboard-v2-efferd，2026-08-05 17:09） |
| 2 | v2-delta 趋势指示器 + 5 测试 | ✅ | `d10f9a4c` |
| 3 | v2-stats KPI 统计卡 + 7 测试 | ✅ | `cb8e8746` |
| 4 | v2-revenue-chart 渐变柱状图 | ✅ | `08105436` |
| 5 | v2-channel-chart 双折线图 | ✅ | `b22d9c79` |
| 6 | mock 区块（invoices/billing/activity） | ✅ | `aa42f8e5` |
| 7 | v2 页面 + 项目级过滤 + 4 测试 | ✅ | `75e46947` |
| 8 | v1 试试新版按钮 + loading.tsx | ✅ | `9a90f6fe` |

## 交付内容

- **新路由**：`/dashboard/v2`（Efferd 密集网格实验页：4 KPI 卡 + 渐变柱状图 + 双折线图 + 3 个 mock 区块）
- **互跳**：`/dashboard`（v1）↔ `/dashboard/v2`，均为 `next/link` 无状态切换
- **项目过滤**：v2 页面级 ProjectSelect（"全部项目"= v1 行为 / 单项目过滤）
- **性能**：recharts 双图 `next/dynamic` + `ssr:false` 拆包（沿用 v1 策略）
- **测试**：新增 16 个单测（delta 5 + stats 7 + page 4），全量 416 通过

## 与计划的偏差（实施中修正）

1. **v2-stats loading 断言**：项目 Skeleton 用自定义 `u-skeleton-shimmer`（非默认 `animate-pulse`），测试改为断言实际类名
2. **page.test 稳定性**：`useManagedProjects` / `useNotifications` mock 改为模块级常量，避免每次 render 新引用导致 effect/loadData 无限重跑、loading 状态振荡（fetch 永不落定假象）——生产实现本身无此问题（context/缓存引用稳定）
3. **mock 区块**：sample 的 TW4 `mask-*` 工具类（TW3.4 不存在）改为 arbitrary `[mask-image:...]`；`IconPlaceholder` 多图标库抽象替换为 lucide 直引
4. **loading.tsx**：`app/dashboard/v2/loading.tsx` 新增（BEL-419 路由骨架覆盖守卫要求每个含页面 section 自带 loading）

## 手动验证清单（交用户）

- [ ] `/dashboard` 右上角出现"试试新版"，点击跳转 `/dashboard/v2`
- [ ] `/dashboard/v2` 顶部有项目选择器（默认"全部项目"）+ "返回旧版"按钮，点击返回 `/dashboard`
- [ ] 亮色/暗色主题下：发丝线网格、纯平卡片、Delta 绿涨红跌均正常
- [ ] 4 个 KPI 卡显示中文标签 + `$` 金额 + 环比 delta
- [ ] 销售额柱状图（渐变柱）与双折线图渲染，tooltip 可用
- [ ] 切换单个项目后 KPI/图表数据刷新；切回"全部项目"恢复
- [ ] Recent invoices / Billing health / Activity 三个 mock 区块显示英文占位内容
- [ ] 移动端（<768px）回退 1 列布局
- [ ] 断网或后端挂掉时：真实数据区显示"暂无销售数据 + 重试"，mock 区块不受影响

## 外部关联

- **验收 issue**：BLF-450（确认 V2 进度 + 集成 V1/V2 切换）
- **数据快照**：新增 16 测试（delta 5 / stats 7 / page 4）；全量 78 文件 416 测试通过；`pnpm lint` 0 错误；`pnpm build` 含 `/dashboard/v2` 路由
